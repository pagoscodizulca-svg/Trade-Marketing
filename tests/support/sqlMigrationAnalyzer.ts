/**
 * Analizador ESTÁTICO de migraciones SQL (sin motor PostgreSQL).
 *
 * Simula, en orden lexicográfico de archivo, el estado del esquema `public` y detecta
 * defectos de orden/integridad que rompen una reconstrucción desde cero:
 *   - tablas, columnas y tipos inexistentes en el momento de usarse (índices, FK, ALTER, políticas, triggers);
 *   - funciones `public.*` / `private.*` referenciadas por políticas, índices o triggers antes de crearse;
 *   - `CREATE TABLE IF NOT EXISTS` sobre una tabla ya creada (las columnas del segundo CREATE se IGNORAN,
 *     que es exactamente el defecto N-01);
 *   - nombres de archivo con prefijos legados o formato inválido, y versiones duplicadas;
 *   - comandos destructivos (`DROP TABLE`, `TRUNCATE`).
 *
 * LIMITACIONES CONOCIDAS (no sustituye a PostgreSQL real):
 *   - No ejecuta SQL dinámico (`EXECUTE format(...)`) ni interpreta cuerpos de funciones.
 *   - Los bloques `DO` con guardas (`to_regclass`, `to_regprocedure`, `IF EXISTS`, `EXCEPTION`) se
 *     tratan como opcionales: no generan error si la tabla no existe.
 *   - Las comprobaciones de columnas en índices cubren columnas simples y expresiones comunes.
 * La verificación contra un motor real se hace con el certificador de esquema (Hito 2).
 */

export interface MigrationFile {
  name: string;
  sql: string;
}

export type IssueSeverity = 'error' | 'warning';

export interface MigrationIssue {
  severity: IssueSeverity;
  code: string;
  file: string;
  line: number;
  message: string;
}

export interface AnalysisResult {
  issues: MigrationIssue[];
  errors: MigrationIssue[];
  warnings: MigrationIssue[];
  tables: Map<string, Set<string>>;
  functions: Set<string>;
  types: Set<string>;
  policies: Map<string, Set<string>>;
}

type SegmentType = 'code' | 'string' | 'ident' | 'dollar' | 'comment';

interface Segment {
  type: SegmentType;
  start: number;
  end: number;
}

const IDENT = '(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)';
const QUALIFIED = `(?:${IDENT}\\.)?${IDENT}`;

const INDEX_KEYWORDS = new Set([
  'asc',
  'desc',
  'nulls',
  'first',
  'last',
  'and',
  'or',
  'not',
  'is',
  'null',
  'in',
  'true',
  'false',
  'text',
  'date',
  'jsonb',
  'json',
  'uuid',
  'integer',
  'int',
  'boolean',
  'numeric',
  'timestamptz',
  'timestamp',
  'varchar',
  'bigint',
  'interval',
  'collate',
  'public',
  'pg_catalog',
  'using',
  'gin',
  'btree',
  'gist',
  'brin',
  'hash',
  'text_pattern_ops',
  'varchar_pattern_ops',
  'case',
  'when',
  'then',
  'else',
  'end',
  'at',
  'time',
  'zone',
  'extract',
  'from',
]);

// ---------------------------------------------------------------------------
// Tokenización consciente de comentarios, cadenas, identificadores y dollar-quoting
// ---------------------------------------------------------------------------
function tokenize(sql: string): Segment[] {
  const segments: Segment[] = [];
  const n = sql.length;
  let i = 0;
  let codeStart = 0;

  const flushCode = (end: number) => {
    if (end > codeStart) segments.push({ type: 'code', start: codeStart, end });
  };

  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];

    if (c === '-' && d === '-') {
      flushCode(i);
      let j = i;
      while (j < n && sql[j] !== '\n') j += 1;
      segments.push({ type: 'comment', start: i, end: j });
      i = j;
      codeStart = i;
      continue;
    }

    if (c === '/' && d === '*') {
      flushCode(i);
      const close = sql.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      segments.push({ type: 'comment', start: i, end });
      i = end;
      codeStart = i;
      continue;
    }

    if (c === "'") {
      flushCode(i);
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      segments.push({ type: 'string', start: i, end: Math.min(j + 1, n) });
      i = Math.min(j + 1, n);
      codeStart = i;
      continue;
    }

    if (c === '"') {
      flushCode(i);
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      segments.push({ type: 'ident', start: i, end: Math.min(j + 1, n) });
      i = Math.min(j + 1, n);
      codeStart = i;
      continue;
    }

    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        flushCode(i);
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close + tag.length;
        segments.push({ type: 'dollar', start: i, end });
        i = end;
        codeStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushCode(n);
  return segments;
}

/** Reemplaza comentarios por espacios (conserva saltos de línea y offsets). */
function maskComments(sql: string, segments: Segment[]): string {
  const chars = sql.split('');
  for (const seg of segments) {
    if (seg.type !== 'comment') continue;
    for (let k = seg.start; k < seg.end; k += 1) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  }
  return chars.join('');
}

interface Statement {
  text: string;
  start: number;
}

function splitStatements(masked: string, segments: Segment[]): Statement[] {
  const statements: Statement[] = [];
  let stmtStart = 0;

  const pushStatement = (end: number) => {
    const raw = masked.slice(stmtStart, end);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const lead = raw.length - raw.trimStart().length;
      statements.push({ text: trimmed, start: stmtStart + lead });
    }
  };

  for (const seg of segments) {
    if (seg.type !== 'code') continue;
    for (let k = seg.start; k < seg.end; k += 1) {
      if (masked[k] === ';') {
        pushStatement(k);
        stmtStart = k + 1;
      }
    }
  }
  pushStatement(masked.length);
  return statements;
}

function lineOf(sql: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset && k < sql.length; k += 1) {
    if (sql[k] === '\n') line += 1;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Utilidades de parseo
// ---------------------------------------------------------------------------
function unquote(identifier: string): string {
  const t = identifier.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t.toLowerCase();
}

interface QualifiedName {
  schema: string;
  name: string;
}

function parseQualified(raw: string): QualifiedName {
  const parts = raw.trim().match(new RegExp(IDENT, 'g')) ?? [];
  if (parts.length >= 2) return { schema: unquote(parts[0]!), name: unquote(parts[1]!) };
  return { schema: 'public', name: unquote(parts[0] ?? '') };
}

function isSimpleName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name);
}

/** Devuelve el contenido entre el paréntesis de apertura en `openIdx` y su cierre, partido por comas de nivel 1. */
function splitTopLevel(text: string, openIdx: number): { parts: string[]; endIdx: number } {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = openIdx;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j < 0 ? n : j;
      current += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '(') {
      depth += 1;
      if (depth > 1) current += c;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        parts.push(current);
        return { parts, endIdx: i };
      }
      current += c;
    } else if (c === ',' && depth === 1) {
      parts.push(current);
      current = '';
    } else if (depth >= 1) {
      current += c;
    }
    i += 1;
  }
  parts.push(current);
  return { parts, endIdx: n };
}

function splitCommasTopLevel(text: string): string[] {
  return splitTopLevel(`(${text})`, 0).parts;
}

function stripLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, ' ').replace(/\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$/g, ' ');
}

// ---------------------------------------------------------------------------
// Verificación de nombres de archivo
// ---------------------------------------------------------------------------
export function checkMigrationNaming(fileNames: string[]): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const byVersion = new Map<string, string[]>();

  for (const name of fileNames) {
    if (!name.endsWith('.sql')) continue;
    if (/^\d{1,3}_/.test(name)) {
      issues.push({
        severity: 'error',
        code: 'LEGACY_PREFIX',
        file: name,
        line: 1,
        message:
          'Prefijo legado (1-3 dígitos): se ordena ANTES que las migraciones con marca de tiempo y rompe la reconstrucción desde cero.',
      });
      continue;
    }
    const m = /^(\d{8}|\d{14})_[a-z0-9_]+\.sql$/i.exec(name);
    if (!m) {
      issues.push({
        severity: 'error',
        code: 'INVALID_NAME',
        file: name,
        line: 1,
        message: 'Formato esperado: <AAAAMMDD|AAAAMMDDHHMMSS>_descripcion.sql',
      });
      continue;
    }
    const version = m[1]!;
    byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
  }

  for (const [version, names] of byVersion) {
    if (names.length > 1) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_VERSION',
        file: names.join(', '),
        line: 1,
        message: `Versión ${version} repetida en ${names.length} archivos: la CLI de Supabase exige versiones únicas.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Simulación del esquema
// ---------------------------------------------------------------------------
class SchemaState {
  tables = new Map<string, Set<string>>();
  functions = new Set<string>();
  types = new Set<string>();
  policies = new Map<string, Set<string>>();
}

export function analyzeMigrations(files: MigrationFile[]): AnalysisResult {
  const issues: MigrationIssue[] = [...checkMigrationNaming(files.map((f) => f.name))];
  const state = new SchemaState();

  const ordered = [...files].filter((f) => f.name.endsWith('.sql')).sort((a, b) => a.name.localeCompare(b.name));

  for (const file of ordered) {
    const segments = tokenize(file.sql);
    const masked = maskComments(file.sql, segments);
    const statements = splitStatements(masked, segments);

    const report = (
      severity: IssueSeverity,
      code: string,
      offset: number,
      message: string
    ) => {
      issues.push({ severity, code, file: file.name, line: lineOf(file.sql, offset), message });
    };

    const registerFunctions = (text: string) => {
      const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${QUALIFIED})\\s*\\(`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const q = parseQualified(m[1]!);
        state.functions.add(`${q.schema}.${q.name}`);
      }
    };

    const checkFunctionRefs = (text: string, offset: number, optional: boolean) => {
      const re = /\b(public|private)\.([a-z_][a-z0-9_]*)\s*\(/gi;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      const cleaned = stripLiterals(text);
      while ((m = re.exec(cleaned)) !== null) {
        const key = `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!state.functions.has(key) && !optional) {
          report(
            'error',
            'FUNCTION_NOT_FOUND',
            offset,
            `La función ${key}() se referencia antes de crearse.`
          );
        }
      }
    };

    const requireTable = (
      q: QualifiedName,
      offset: number,
      optional: boolean,
      context: string
    ): boolean => {
      if (q.schema !== 'public') return false;
      if (!isSimpleName(q.name)) return false;
      if (state.tables.has(q.name)) return true;
      if (!optional) {
        report('error', 'TABLE_NOT_FOUND', offset, `${context}: la tabla public.${q.name} no existe en este punto del orden de migraciones.`);
      }
      return false;
    };

    const checkTypeAndRefs = (
      definition: string,
      selfTable: string | null,
      offset: number,
      optional: boolean
    ) => {
      const typeMatch = /^\s*(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s+public\.([a-z_][a-z0-9_]*)/i.exec(definition);
      if (typeMatch) {
        const typeName = typeMatch[1]!.toLowerCase();
        if (!state.types.has(typeName) && !state.tables.has(typeName) && typeName !== selfTable && !optional) {
          report('error', 'TYPE_NOT_FOUND', offset, `El tipo public.${typeName} no existe en este punto.`);
        }
      }
      const refRe = new RegExp(`REFERENCES\\s+(${QUALIFIED})`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = refRe.exec(definition)) !== null) {
        const q = parseQualified(m[1]!);
        if (q.schema !== 'public' || !isSimpleName(q.name)) continue;
        if (q.name === selfTable) continue;
        if (!state.tables.has(q.name) && !optional) {
          report('error', 'FK_TARGET_NOT_FOUND', offset, `FOREIGN KEY hacia public.${q.name}, que aún no existe.`);
        }
      }
    };

    const processStatement = (rawText: string, offset: number, optional: boolean) => {
      const text = rawText.trim();
      if (!text) return;

      // --- Funciones y tipos -------------------------------------------------
      registerFunctions(text);

      const typeCreate = new RegExp(`^CREATE\\s+TYPE\\s+(${QUALIFIED})`, 'i').exec(text);
      if (typeCreate) {
        const q = parseQualified(typeCreate[1]!);
        if (q.schema === 'public') state.types.add(q.name);
        return;
      }

      // --- Comandos destructivos ---------------------------------------------
      if (/^DROP\s+TABLE\b/i.test(text)) {
        report('error', 'DESTRUCTIVE_DROP_TABLE', offset, 'DROP TABLE prohibido en migraciones.');
        return;
      }
      if (/^TRUNCATE\b/i.test(text)) {
        report('error', 'DESTRUCTIVE_TRUNCATE', offset, 'TRUNCATE prohibido en migraciones.');
        return;
      }

      // --- CREATE TABLE -------------------------------------------------------
      const createTable = new RegExp(
        `^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})\\s*\\(`,
        'i'
      ).exec(text);
      if (createTable) {
        const q = parseQualified(createTable[2]!);
        if (q.schema !== 'public' || !isSimpleName(q.name)) return;
        const exists = state.tables.has(q.name);

        if (exists && createTable[1]) {
          // IF NOT EXISTS sobre tabla ya creada: el CREATE completo es un no-op (N-01).
          return;
        }
        if (exists) {
          report('error', 'TABLE_ALREADY_EXISTS', offset, `CREATE TABLE sin IF NOT EXISTS sobre public.${q.name}, ya creada.`);
          return;
        }

        const openIdx = text.indexOf('(', createTable[0].length - 1);
        const { parts } = splitTopLevel(text, openIdx);
        const columns = new Set<string>();
        state.tables.set(q.name, columns);

        for (const part of parts) {
          const def = part.trim();
          if (!def) continue;
          if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i.test(def)) {
            checkTypeAndRefs(def, q.name, offset, optional);
            continue;
          }
          const nameMatch = new RegExp(`^(${IDENT})`).exec(def);
          if (nameMatch) columns.add(unquote(nameMatch[1]!));
          checkTypeAndRefs(def, q.name, offset, optional);
        }
        return;
      }

      // --- ALTER TABLE --------------------------------------------------------
      const alterTable = new RegExp(
        `^ALTER\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED})\\s+([\\s\\S]*)$`,
        'i'
      ).exec(text);
      if (alterTable) {
        const q = parseQualified(alterTable[2]!);
        if (q.schema !== 'public' || !isSimpleName(q.name)) return;
        const ifExists = Boolean(alterTable[1]);
        if (!requireTable(q, offset, optional || ifExists, 'ALTER TABLE')) return;

        const columns = state.tables.get(q.name)!;
        const actions = splitCommasTopLevel(alterTable[3]!);

        for (const actionRaw of actions) {
          const action = actionRaw.trim();

          const addCol = new RegExp(`^ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})([\\s\\S]*)$`, 'i').exec(action);
          if (addCol) {
            const col = unquote(addCol[2]!);
            if (columns.has(col)) {
              if (!addCol[1] && !optional) {
                report('error', 'DUPLICATE_COLUMN', offset, `ADD COLUMN ${col} sin IF NOT EXISTS: ya existe en public.${q.name}.`);
              }
            } else {
              columns.add(col);
            }
            checkTypeAndRefs(`${col} ${addCol[3]!}`, q.name, offset, optional);
            continue;
          }

          const dropCol = new RegExp(`^DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, 'i').exec(action);
          if (dropCol) {
            columns.delete(unquote(dropCol[1]!));
            continue;
          }

          const renameCol = new RegExp(`^RENAME\\s+COLUMN\\s+(${IDENT})\\s+TO\\s+(${IDENT})`, 'i').exec(action);
          if (renameCol) {
            const from = unquote(renameCol[1]!);
            if (columns.has(from)) {
              columns.delete(from);
              columns.add(unquote(renameCol[2]!));
            } else if (!optional) {
              report('error', 'COLUMN_NOT_FOUND', offset, `RENAME COLUMN: ${from} no existe en public.${q.name}.`);
            }
            continue;
          }

          const alterCol = new RegExp(`^ALTER\\s+COLUMN\\s+(${IDENT})`, 'i').exec(action);
          if (alterCol) {
            const col = unquote(alterCol[1]!);
            if (!columns.has(col) && !optional) {
              report('error', 'COLUMN_NOT_FOUND', offset, `ALTER COLUMN: ${col} no existe en public.${q.name}.`);
            }
            continue;
          }

          const renameTable = new RegExp(`^RENAME\\s+TO\\s+(${IDENT})`, 'i').exec(action);
          if (renameTable) {
            const newName = unquote(renameTable[1]!);
            state.tables.set(newName, columns);
            state.tables.delete(q.name);
            continue;
          }

          if (/^ADD\s+CONSTRAINT\b/i.test(action) || /^ADD\s+(?:FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(action)) {
            checkTypeAndRefs(action, q.name, offset, optional);
          }
        }
        return;
      }

      // --- CREATE INDEX -------------------------------------------------------
      const createIndex = new RegExp(
        `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${QUALIFIED})\\s*(?:USING\\s+\\w+\\s*)?\\(`,
        'i'
      ).exec(text);
      if (createIndex) {
        const q = parseQualified(createIndex[1]!);
        if (q.schema !== 'public' || !isSimpleName(q.name)) return;
        if (!requireTable(q, offset, optional, 'CREATE INDEX')) return;

        const columns = state.tables.get(q.name)!;
        const openIdx = text.indexOf('(', createIndex[0].length - 1);
        const { parts, endIdx } = splitTopLevel(text, openIdx);

        for (const element of parts) {
          let expr = stripLiterals(element);
          expr = expr.replace(/::\s*(?:public\.)?[a-z_][a-z0-9_]*(?:\([^)]*\))?(?:\[\])?/gi, ' ');
          expr = expr.replace(/(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*\s*\(/gi, '(');
          const words = expr.match(/"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
          for (const w of words) {
            const col = unquote(w);
            if (INDEX_KEYWORDS.has(col)) continue;
            if (!columns.has(col) && !optional) {
              report(
                'error',
                'COLUMN_NOT_FOUND',
                offset,
                `CREATE INDEX sobre public.${q.name}: la columna "${col}" no existe en este punto (¿una migración previa dejó la tabla sin esa columna?).`
              );
            }
          }
        }
        // Solo la lista de columnas/expresiones y el predicado: `ON public.tabla (` NO es una llamada a función.
        checkFunctionRefs(text.slice(openIdx), offset, optional);
        return;
      }

      // --- POLÍTICAS RLS ------------------------------------------------------
      const createPolicy = new RegExp(`^CREATE\\s+POLICY\\s+(${IDENT})\\s+ON\\s+(${QUALIFIED})`, 'i').exec(text);
      if (createPolicy) {
        const q = parseQualified(createPolicy[2]!);
        if (q.schema !== 'public' || !isSimpleName(q.name)) return;
        if (!requireTable(q, offset, optional, 'CREATE POLICY')) return;
        const polName = unquote(createPolicy[1]!);
        const set = state.policies.get(q.name) ?? new Set<string>();
        if (set.has(polName) && !optional) {
          report('error', 'DUPLICATE_POLICY', offset, `La política ${polName} ya existe en public.${q.name} (falta DROP POLICY IF EXISTS).`);
        }
        set.add(polName);
        state.policies.set(q.name, set);
        checkFunctionRefs(text, offset, optional);
        return;
      }

      const dropPolicy = new RegExp(`^DROP\\s+POLICY\\s+(IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${QUALIFIED})`, 'i').exec(text);
      if (dropPolicy) {
        const q = parseQualified(dropPolicy[3]!);
        if (q.schema === 'public' && isSimpleName(q.name)) {
          if (!dropPolicy[1]) requireTable(q, offset, optional, 'DROP POLICY');
          state.policies.get(q.name)?.delete(unquote(dropPolicy[2]!));
        }
        return;
      }

      // --- TRIGGERS -----------------------------------------------------------
      const createTrigger = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${IDENT}[\\s\\S]*?\\sON\\s+(${QUALIFIED})`, 'i').exec(text);
      if (createTrigger) {
        const q = parseQualified(createTrigger[1]!);
        if (q.schema === 'public' && isSimpleName(q.name)) {
          requireTable(q, offset, optional, 'CREATE TRIGGER');
        }
        const execFn = new RegExp(`EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+(${QUALIFIED})\\s*\\(`, 'i').exec(text);
        if (execFn) {
          const fq = parseQualified(execFn[1]!);
          if (fq.schema === 'public' || fq.schema === 'private') {
            if (!state.functions.has(`${fq.schema}.${fq.name}`) && !optional) {
              report('error', 'FUNCTION_NOT_FOUND', offset, `El trigger usa ${fq.schema}.${fq.name}(), aún no creada.`);
            }
          }
        }
        return;
      }

      // --- GRANT / REVOKE sobre tablas ---------------------------------------
      const grantRevoke = new RegExp(`^(?:GRANT|REVOKE)\\b[\\s\\S]*?\\bON\\s+(?:TABLE\\s+)?(${QUALIFIED})\\s+(?:TO|FROM)\\b`, 'i').exec(text);
      if (grantRevoke && !/\bON\s+(?:FUNCTION|SCHEMA|ALL|SEQUENCE)\b/i.test(text)) {
        const q = parseQualified(grantRevoke[1]!);
        if (q.schema === 'public' && isSimpleName(q.name)) {
          requireTable(q, offset, optional, text.slice(0, 6).toUpperCase());
        }
        return;
      }

      // --- INSERT / UPDATE (solo existencia de tabla) -------------------------
      const insertInto = new RegExp(`^INSERT\\s+INTO\\s+(${QUALIFIED})`, 'i').exec(text);
      const updateTbl = new RegExp(`^UPDATE\\s+(?:ONLY\\s+)?(${QUALIFIED})\\s+(?:AS\\s+\\w+\\s+)?SET\\b`, 'i').exec(text);
      const dml = insertInto ?? updateTbl;
      if (dml) {
        const q = parseQualified(dml[1]!);
        if (q.schema === 'public' && isSimpleName(q.name)) {
          requireTable(q, offset, optional, insertInto ? 'INSERT' : 'UPDATE');
        }
      }
    };

    for (const stmt of statements) {
      const head = stmt.text;

      // Bloques DO: se analizan sus sentencias internas de forma conservadora
      if (/^DO\b/i.test(head)) {
        registerFunctions(head);
        const innerSegs = tokenize(head);
        const dollar = innerSegs.find((s) => s.type === 'dollar');
        if (!dollar) continue;
        const tagMatch = /^\$[A-Za-z_]*\$/.exec(head.slice(dollar.start, dollar.start + 64));
        const tagLen = tagMatch ? tagMatch[0].length : 2;
        const body = head.slice(dollar.start + tagLen, Math.max(dollar.start + tagLen, dollar.end - tagLen));
        const optionalBlock = /to_regclass\(|to_regprocedure\(|\bIF\s+EXISTS\b|EXCEPTION\s+WHEN|information_schema|pg_policies|pg_catalog\.pg_extension|pg_extension/i.test(body);

        const bodySegs = tokenize(body);
        const bodyMasked = maskComments(body, bodySegs);

        // Bucle dinámico que elimina políticas (`FROM pg_policies` + `DROP POLICY`): se modela como
        // limpieza de las políticas de las tablas conocidas que aparecen nombradas en el bloque.
        if (/pg_policies/i.test(bodyMasked) && /DROP\s+POLICY/i.test(bodyMasked)) {
          const literals = bodyMasked.match(/'([a-z_][a-z0-9_]*)'/gi) ?? [];
          for (const lit of literals) {
            const tableName = lit.slice(1, -1).toLowerCase();
            if (state.tables.has(tableName)) state.policies.delete(tableName);
          }
        }

        const pieces = splitStatements(bodyMasked, bodySegs);

        for (const piece of pieces) {
          if (/\bEXECUTE\b/i.test(piece.text)) continue;
          const idx = piece.text.search(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|GRANT|REVOKE)\b/i);
          if (idx < 0) continue;
          processStatement(piece.text.slice(idx), stmt.start, optionalBlock);
        }
        continue;
      }

      if (/^(BEGIN|COMMIT|ROLLBACK|SET|RESET|SELECT|COMMENT|CREATE\s+(?:EXTENSION|SCHEMA|SEQUENCE|VIEW|OR\s+REPLACE\s+VIEW))\b/i.test(head)) {
        registerFunctions(head);
        continue;
      }

      processStatement(head, stmt.start, false);
    }
  }

  return {
    issues,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    tables: state.tables,
    functions: state.functions,
    types: state.types,
    policies: state.policies,
  };
}

export function formatIssues(issues: MigrationIssue[]): string {
  return issues
    .map((i) => `[${i.severity.toUpperCase()}][${i.code}] ${i.file}:${i.line} — ${i.message}`)
    .join('\n');
}
