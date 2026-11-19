# CODIZULCA C.A. — Sistema de Diseño Corporativo Suizo (`v1.8.0`)

Documento normativo de diseño de producto, arquitectura cromática, tipografía numérica, micro-interacciones GPU y Co-Branding B2B para el ecosistema **Trade Marketing, Contraloría, Portal Promotoras (`/portal`), Portal Cliente (`/cliente`) y Logística (`/logistica`)**.

---

## 1. Filosofía Visual: Precisión Suiza Corporativa (Cero Estética Genérica de IA)

El sistema visual obedece estrictamente la identidad institucional tricromática **Negro Obsidiana (`#09090B`), Rojo Corporativo (`#DC2626`) y Blanco Puro (`#FFFFFF`)**:
- **Prohibición estricta**: cero gradientes violetas, índigos, fucsias o cian; cero resplandores de neón (`box-shadow` difusos de color); cero emojis decorativos en controles de interfaz (exclusivamente iconografía vectorial `lucide-react` de trazo uniforme).
- **Jerarquía arquitectónica**: retículas limpias, divisores estructurales exactos de `1px`, radio geométrico contenido y alineación numérica tabular en toda cifra operativa o financiera.

---

## 2. Modos Cromáticos Oficiales (`data-theme` / `codizulca.ui_theme`)

La preferencia del operador se persiste en `localStorage` bajo la clave `codizulca.ui_theme` (preservada por `cleanSync.ts`) y se inyecta de forma síncrona mediante `bootTheme.ts` (`script-src 'self'`, cero FOUC y cero scripts inline) sobre `<html data-theme="...">`.

### 2.1 `default` — Modo Día Ejecutivo (Regla `60 / 30 / 10`)
Orientado a trabajo analítico diurno en estaciones administrativas, auditoría documental y portales B2B:
- **60 % Blanco / Hielo (`#FFFFFF` / `#F8F9FA`)**: lienzo operativo (`--cz-bg-canvas: #F8F9FA`), tarjetas y tablas de datos (`--cz-bg-surface: #FFFFFF`), cabeceras secundarias (`--cz-bg-elevated: #F1F3F5`) y bordes de `1px` (`--cz-border-subtle: #E4E4E7`).
- **30 % Negro Obsidiana (`#09090B`)**: anclas estructurales institucionales (`.cz-obsidian-anchor`: barra lateral ejecutiva `Header` y pie corporativo), tipografía primaria de máxima legibilidad (`--cz-text-primary: #09090B`, ratio `19.3:1`) y texto secundario grafito (`--cz-text-secondary: #52525B`, ratio `7.1:1`, WCAG AA `>= 4.5:1`).
- **10 % Rojo Corporativo (`#DC2626` / `#B91C1C`)**: acciones primarias, indicadores deslizantes de pestaña activa (`2px`) y alertas críticas focales.

### 2.2 `control-room` — Modo Oscuro Nocturno Completo (Sala de Control 24/7)
Calibrado específicamente para monitoreo prolongado en monitores y televisores de Sala de Control / Torre Nacional sin fatiga visual ni deslumbramiento:
- **Lienzo base**: `#09090B` plano (`background-image: none`, cero halo radial).
- **Superficies de tarjetas y tablas**: `#121215` (`--cz-bg-surface`).
- **Cabeceras elevadas (`thead`, barras superiores y rieles)**: `#18181B` (`--cz-bg-elevated`).
- **Bordes arquitectónicos**: `1px solid #27272A` (`--cz-border-subtle`) y `#3F3F46` en foco neutro.
- **Texto primario**: `#FAFAFA` (ratio `18.1:1` sobre `#121215`).
- **Texto secundario y ejes de gráficas**: `#A1A1AA` (ratio `7.4:1` sobre `#121215`, superando holgadamente WCAG AA `>= 4.5:1`).
- **Acentos focales**: Rojo Corporativo `#DC2626` / `#EF4444` plano y calibrado, sin neón ni resplandores difusos.

### 2.3 Inmunidad de Soportes Impresos y Exportaciones Documentales
Independientemente de si el monitor opera en `default` o `control-room`, toda salida física o documental (`@media print`, PDF vía `pdfExport.ts`, Excel `.xlsx` y Word `.docx` vía `excelWordExport.ts`) conserva invariablemente su formato claro corporativo de lectura/impresión (papel `#FFFFFF`, tinta `#09090B` / `#141414` y membrete `#DC2626`).

---

## 3. Tipografía y Disciplina Numérica (`tabular-nums`)

- **UI y titulares**: `Plus Jakarta Sans` (`400..800`), tracking `-0.011em`.
- **Códigos, hashes `SHA-256`, correlativos `MP-07-XXXX` y RIF**: `JetBrains Mono`.
- **Métricas y tablas**: `font-variant-numeric: tabular-nums` obligatorio en tarjetas KPI, tablas comparativas de las 5 regiones, montos USD, porcentajes, contadores SLA y relojes operativos para impedir desplazamientos horizontales al actualizar cifras en vivo.

---

## 4. Micro-Transiciones Aceleradas por GPU y Accesibilidad Motriz

- **Cambio de panel (`AnimatedTabContainer`)**: anima exclusivamente propiedades compuestas en GPU (`opacity: 0 -> 1` y `transform: translate3d(0, 4px, 0) -> translate3d(0, 0, 0)`), duración exacta de `150ms` y curva `cubic-bezier(0.16, 1, 0.3, 1)`, sin librerías externas pesadas.
- **Indicador activo deslizante (`SlidingTabRail`)**: línea inferior de `2px` en Rojo Corporativo (`#DC2626`) posicionada mediante `translate3d(x, 0, 0)` sobre la pestaña activa.
- **Respeto absoluto al sistema operativo**: bajo `@media (prefers-reduced-motion: reduce)`, todas las traslaciones y transiciones de desplazamiento se desactivan automáticamente (`transform: none !important; transition: none !important;`).

---

## 5. Co-Branding Ejecutivo B2B en `/cliente` (Zero-Trust)

- **Composición de cabecera**: `[Logo Corporativo CODIZULCA C.A.]  |  [Logo Secundario Cadena Comercial]`, separados por un divisor vertical de `1px`.
- **Cápsula cerámica adaptativa (`.cz-cobrand-capsule`)**: contenedor neutro (`h-9 max-w-[160px] object-contain`, fondo `#F8F9FA` en `default` y `#F4F4F5` con borde `#3F3F46` en `control-room`) que garantiza contraste óptimo incluso en logotipos comerciales con tipografía negra sobre fondo transparente.
- **Respaldo tipográfico limpio**: cuando una cadena comercial no posee logotipo cargado, se presenta una insignia tipográfica ejecutiva con iniciales en monograma y razón comercial (jamás íconos de imagen rota).
- **Seguridad binaria estricta**:
  - Solo se admiten binarios rasterizados `image/png` e `image/webp` (`<= 512 KB`) verificados por *magic bytes* en servidor.
  - Prohibición absoluta de `.svg`, `.xml`, `.html` (prevención XSS/XXE) y de URLs externas arbitrarias (prevención SSRF y cumplimiento de `img-src 'self' data: blob:`).
  - Entrega autenticada con `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600` y liberación determinística de memoria mediante `URL.revokeObjectURL`.
