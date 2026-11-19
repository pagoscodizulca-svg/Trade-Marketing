import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Truck,
} from 'lucide-react';
import {
  buildSignedShiftWhatsAppShareUrl,
  generateSignedShiftLink,
  listRegionShiftLinks,
  revokeSignedShiftLink,
  type ShiftDurationHours,
  type ShiftLinkRole,
  type ShiftSessionSummary,
} from '../../services/shiftLinksService';
import { SUCURSAL_LABELS, type OperativeSucursal } from '../../services/userManagementService';
import { isSupabaseConfigured } from '../../services/supabaseClient';

export interface ShiftPersonalOption {
  id: string;
  name: string;
  roleLabel?: string;
}

export interface ShiftLinkManagerPanelProps {
  sucursal: OperativeSucursal;
  regionNombre?: string;
  promotorasOptions?: ShiftPersonalOption[];
  choferesOptions?: ShiftPersonalOption[];
  routeSuggestions?: string[];
  initialSessions?: ShiftSessionSummary[];
  disableAutoFetch?: boolean;
}

interface GeneratedLinkPreview {
  rol: ShiftLinkRole;
  url: string;
  whatsappUrl: string;
  session: ShiftSessionSummary;
  copied: boolean;
}

const DURATION_OPTIONS: ReadonlyArray<{ value: ShiftDurationHours; label: string }> = [
  { value: 8, label: '8h (Turno)' },
  { value: 12, label: '12h (Jornada)' },
  { value: 24, label: '24h (Extendida)' },
];

function formatVeTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function getSessionStatus(
  session: ShiftSessionSummary,
  nowMs: number
): 'ACTIVO' | 'REVOCADO' | 'EXPIRADO' {
  if (session.revoked_at) return 'REVOCADO';
  const expMs = new Date(session.expires_at).getTime();
  if (!Number.isFinite(expMs) || expMs <= nowMs) return 'EXPIRADO';
  return 'ACTIVO';
}

function formatRemainingWindow(expiresIso: string, nowMs: number): string {
  const diffMs = new Date(expiresIso).getTime() - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'Expirado';
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${mins}m restantes` : `${mins}m restantes`;
}

export const ShiftLinkManagerPanel: React.FC<ShiftLinkManagerPanelProps> = ({
  sucursal,
  regionNombre,
  promotorasOptions = [],
  choferesOptions = [],
  routeSuggestions = [],
  initialSessions,
  disableAutoFetch = false,
}) => {
  const regionLabel = regionNombre || SUCURSAL_LABELS[sucursal] || sucursal;

  const [sessions, setSessions] = useState<ShiftSessionSummary[]>(() => initialSessions ?? []);
  const [loadingList, setLoadingList] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Estado formulario Promotora
  const [promDuration, setPromDuration] = useState<ShiftDurationHours>(12);
  const [promRuta, setPromRuta] = useState<string>('TODAS');
  const [promPersonalId, setPromPersonalId] = useState<string>('');
  const [generatingProm, setGeneratingProm] = useState<boolean>(false);

  // Estado formulario Chofer
  const [choferDuration, setChoferDuration] = useState<ShiftDurationHours>(12);
  const [choferRuta, setChoferRuta] = useState<string>('TODAS');
  const [choferPersonalId, setChoferPersonalId] = useState<string>('');
  const [generatingChofer, setGeneratingChofer] = useState<boolean>(false);

  // Vista previa efímera (solo en memoria del navegador del coordinador, se borra al cambiar de sede)
  const [generatedByRole, setGeneratedByRole] = useState<
    Partial<Record<ShiftLinkRole, GeneratedLinkPreview>>
  >({});
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const normalizedRoutes = useMemo(() => {
    const set = new Set<string>(['TODAS']);
    for (const raw of routeSuggestions) {
      const clean = String(raw || '').trim().toUpperCase();
      if (clean && clean.length <= 120) set.add(clean);
    }
    return Array.from(set).slice(0, 40);
  }, [routeSuggestions]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Limpiar links efímeros al cambiar de región
  useEffect(() => {
    setGeneratedByRole({});
    setPromPersonalId('');
    setChoferPersonalId('');
    setErrorMsg(null);
  }, [sucursal]);

  const loadSessions = useCallback(async () => {
    if (disableAutoFetch || !isSupabaseConfigured) return;
    setLoadingList(true);
    setErrorMsg(null);
    try {
      const list = await listRegionShiftLinks(sucursal);
      setSessions(list);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudieron consultar los enlaces dinámicos.'
      );
    } finally {
      setLoadingList(false);
    }
  }, [disableAutoFetch, sucursal]);

  useEffect(() => {
    if (initialSessions) {
      setSessions(initialSessions);
      return;
    }
    void loadSessions();
  }, [initialSessions, loadSessions]);

  const activeCount = useMemo(
    () => sessions.filter((s) => getSessionStatus(s, nowMs) === 'ACTIVO').length,
    [sessions, nowMs]
  );

  const handleGenerate = async (rol: ShiftLinkRole) => {
    const isProm = rol === 'promotora';
    const duration = isProm ? promDuration : choferDuration;
    const rutaCodigo = (isProm ? promRuta : choferRuta).trim().toUpperCase() || 'TODAS';
    const personalId = (isProm ? promPersonalId : choferPersonalId).trim() || null;
    const personalList = isProm ? promotorasOptions : choferesOptions;
    const matchedPerson = personalId ? personalList.find((p) => p.id === personalId) : null;

    if (isProm) setGeneratingProm(true);
    else setGeneratingChofer(true);
    setErrorMsg(null);
    setFeedbackMsg(null);

    try {
      const res = await generateSignedShiftLink({
        rol,
        duracionHoras: duration,
        rutaCodigo,
        personalId,
        personalNombre: matchedPerson?.name ?? '',
        sucursal,
      });

      const whatsappUrl = buildSignedShiftWhatsAppShareUrl({
        signedUrl: res.url,
        rol,
        regionLabel,
        rutaCodigo: res.session.ruta_codigo,
        duracionHoras: duration,
        personalNombre: res.session.personal_nombre || undefined,
      });

      setGeneratedByRole((prev) => ({
        ...prev,
        [rol]: {
          rol,
          url: res.url,
          whatsappUrl,
          session: res.session,
          copied: false,
        },
      }));
      setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
      setFeedbackMsg(
        `Enlace firmado (${duration}h) generado para ${isProm ? 'Promotoras' : 'Chofer'} · ${regionLabel}.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudo generar el enlace dinámico firmado.'
      );
    } finally {
      if (isProm) setGeneratingProm(false);
      else setGeneratingChofer(false);
    }
  };

  const handleCopyForWhatsApp = async (rol: ShiftLinkRole) => {
    const item = generatedByRole[rol];
    if (!item) return;

    const shareMessage = [
      `CODIZULCA C.A. — ${rol === 'chofer' ? 'Acceso Chofer Logística' : 'Plataforma Promotoras'} (${regionLabel})`,
      `Ruta/Jornada: ${item.session.ruta_codigo} · Vigencia: ${item.session.duracion_horas}h`,
      item.url,
    ].join('\n');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareMessage);
      } else {
        throw new Error('Clipboard no disponible');
      }
    } catch {
      const ta = document.createElement('textarea');
      ta.value = shareMessage;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }

    setGeneratedByRole((prev) =>
      prev[rol] ? { ...prev, [rol]: { ...prev[rol]!, copied: true } } : prev
    );
    window.setTimeout(() => {
      setGeneratedByRole((prev) =>
        prev[rol] ? { ...prev, [rol]: { ...prev[rol]!, copied: false } } : prev
      );
    }, 2800);
  };

  const handleRevoke = async (session: ShiftSessionSummary) => {
    if (revokingId) return;
    setRevokingId(session.id);
    setErrorMsg(null);
    setFeedbackMsg(null);
    try {
      const updated = await revokeSignedShiftLink(session.id, sucursal);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setGeneratedByRole((prev) => {
        const next = { ...prev };
        if (next.promotora?.session.id === updated.id) delete next.promotora;
        if (next.chofer?.session.id === updated.id) delete next.chofer;
        return next;
      });
      setFeedbackMsg(`Enlace revocado de inmediato (${updated.rol} · ${updated.ruta_codigo}).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo revocar el enlace.');
    } finally {
      setRevokingId(null);
    }
  };

  const renderGeneratorCard = (config: {
    rol: ShiftLinkRole;
    title: string;
    subtitle: string;
    icon: React.ReactNode;
    duration: ShiftDurationHours;
    setDuration: (v: ShiftDurationHours) => void;
    ruta: string;
    setRuta: (v: string) => void;
    personalId: string;
    setPersonalId: (v: string) => void;
    personalOptions: ShiftPersonalOption[];
    personalPlaceholder: string;
    generating: boolean;
  }) => {
    const generated = generatedByRole[config.rol];
    const routeListId = `shift-routes-${config.rol}-${sucursal.toLowerCase()}`;

    return (
      <div
        data-testid={`shift-link-card-${config.rol}`}
        className="rounded-2xl bg-zinc-950/95 border border-white/10 p-4 space-y-3.5 flex flex-col justify-between"
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/35 flex items-center justify-center shrink-0">
                {config.icon}
              </div>
              <div className="min-w-0">
                <h4 className="text-xs sm:text-sm font-extrabold text-white truncate">
                  {config.title}
                </h4>
                <p className="text-[11px] text-zinc-400 truncate">{config.subtitle}</p>
              </div>
            </div>
            <span className="shrink-0 text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-zinc-900 border border-white/10 text-zinc-300">
              HMAC-SHA256
            </span>
          </div>

          {/* Selector de Vigencia (8h / 12h / 24h) */}
          <div>
            <label className="block text-[11px] font-bold text-zinc-300 mb-1.5">
              Vigencia del enlace (expiración UTC)
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`shift-duration-${config.rol}-${opt.value}h`}
                  onClick={() => config.setDuration(opt.value)}
                  className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                    config.duration === opt.value
                      ? 'bg-[#DC2626] text-white border-[#DC2626]'
                      : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label
                htmlFor={`shift-ruta-${config.rol}`}
                className="block text-[11px] font-bold text-zinc-300 mb-1"
              >
                Ruta / Jornada
              </label>
              <input
                id={`shift-ruta-${config.rol}`}
                list={routeListId}
                type="text"
                maxLength={120}
                value={config.ruta}
                onChange={(e) => config.setRuta(e.target.value)}
                placeholder="Ej. TODAS o RUTA-NORTE"
                className="w-full px-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-500"
              />
              <datalist id={routeListId}>
                {normalizedRoutes.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </div>

            <div>
              <label
                htmlFor={`shift-personal-${config.rol}`}
                className="block text-[11px] font-bold text-zinc-300 mb-1"
              >
                Asignar a ({regionLabel})
              </label>
              <select
                id={`shift-personal-${config.rol}`}
                value={config.personalId}
                onChange={(e) => config.setPersonalId(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
              >
                <option value="">{config.personalPlaceholder}</option>
                {config.personalOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.roleLabel ? ` (${p.roleLabel})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-2.5 pt-1">
          <button
            type="button"
            data-testid={`btn-generate-shift-${config.rol}`}
            disabled={config.generating}
            onClick={() => void handleGenerate(config.rol)}
            className="w-full py-2 px-3.5 rounded-xl bg-[#DC2626] hover:bg-red-500 disabled:opacity-55 text-white text-xs font-extrabold inline-flex items-center justify-center gap-2 transition cursor-pointer"
          >
            {config.generating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Firmando enlace seguro...</span>
              </>
            ) : (
              <>
                <KeyRound className="w-3.5 h-3.5" />
                <span>Generar Enlace Firmado ({config.duration}h)</span>
              </>
            )}
          </button>

          {generated && (
            <div
              data-testid={`shift-generated-box-${config.rol}`}
              className="rounded-xl bg-emerald-950/35 border border-emerald-500/35 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-bold text-emerald-300 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Enlace activo · Cero PII en URL
                </span>
                <span className="font-mono text-[10px] text-zinc-300">
                  Expira: {formatVeTimestamp(generated.session.expires_at)}
                </span>
              </div>

              <div className="px-2.5 py-1.5 rounded-lg bg-black/80 border border-white/10 font-mono text-[10px] text-zinc-300 truncate select-all">
                {generated.url}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid={`btn-copy-whatsapp-${config.rol}`}
                  onClick={() => void handleCopyForWhatsApp(config.rol)}
                  className="flex-1 py-1.5 px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/15 text-xs font-bold text-white inline-flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  {generated.copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>¡Copiado para WhatsApp!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-red-400" />
                      <span>Copiar enlace para WhatsApp</span>
                    </>
                  )}
                </button>

                <a
                  href={generated.whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-1.5 px-2.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/45 text-emerald-200 text-xs font-bold inline-flex items-center gap-1.5 transition"
                  title="Abrir WhatsApp con el enlace firmado listo para enviar"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>WhatsApp</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <section
      data-testid="shift-link-manager-panel"
      className="rounded-2xl bg-zinc-950/90 border border-white/10 p-4 sm:p-5 space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3.5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-600/15 border border-red-500/35 flex items-center justify-center shrink-0">
            <Link2 className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm sm:text-base font-extrabold text-white">
                Enlaces Dinámicos Firmados por Jornada · {regionLabel}
              </h3>
              <span
                data-testid="shift-active-links-counter"
                className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 tabular-nums"
              >
                {activeCount} {activeCount === 1 ? 'enlace activo' : 'enlaces activos'}
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Acceso temporal sin PII en la URL, acotado por región/ruta con expiración automática y revocación al instante (PWA Offline-First).
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void loadSessions()}
          disabled={loadingList}
          className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5 self-start sm:self-auto cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingList ? 'animate-spin text-red-400' : ''}`} />
          <span>Actualizar</span>
        </button>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {feedbackMsg && (
        <div
          role="status"
          className="rounded-xl bg-emerald-950/40 border border-emerald-500/35 px-3.5 py-2 text-xs text-emerald-200 flex items-center gap-2"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{feedbackMsg}</span>
        </div>
      )}

      {/* Tarjetas de Generación: Promotoras y Chofer */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {renderGeneratorCard({
          rol: 'promotora',
          title: 'Link Dinámico Plataforma Promotoras',
          subtitle: 'Acceso PWA /portal?t=... con geocerca y cola offline',
          icon: <Smartphone className="w-4 h-4 text-red-400" />,
          duration: promDuration,
          setDuration: setPromDuration,
          ruta: promRuta,
          setRuta: setPromRuta,
          personalId: promPersonalId,
          setPersonalId: setPromPersonalId,
          personalOptions: promotorasOptions,
          personalPlaceholder: 'Cualquier promotora de la ruta',
          generating: generatingProm,
        })}

        {renderGeneratorCard({
          rol: 'chofer',
          title: 'Link Dinámico Acceso Chofer',
          subtitle: 'Acceso PWA /logistica/?t=... con check-ins offline',
          icon: <Truck className="w-4 h-4 text-red-400" />,
          duration: choferDuration,
          setDuration: setChoferDuration,
          ruta: choferRuta,
          setRuta: setChoferRuta,
          personalId: choferPersonalId,
          setPersonalId: setChoferPersonalId,
          personalOptions: choferesOptions,
          personalPlaceholder: 'Cualquier chofer de la sede',
          generating: generatingChofer,
        })}
      </div>

      {/* Tabla de Enlaces Activos y Recientes */}
      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
        <div className="px-3.5 py-2.5 bg-zinc-900/70 border-b border-white/[0.06] flex items-center justify-between gap-2">
          <span className="text-[11px] font-extrabold uppercase tracking-wider text-zinc-300">
            Control de Enlaces Emitidos · {regionLabel}
          </span>
          <span className="text-[10px] font-mono text-zinc-400">
            Solo SHA-256 hash almacenado en PostgreSQL
          </span>
        </div>

        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-zinc-950/90 text-[10px] font-extrabold uppercase tracking-wider text-zinc-400 border-b border-white/[0.06]">
                <th className="py-2 px-3">Portal / Rol</th>
                <th className="py-2 px-3">Ruta / Personal</th>
                <th className="py-2 px-3">Vigencia</th>
                <th className="py-2 px-3">Estado</th>
                <th className="py-2 px-3">Último Uso</th>
                <th className="py-2 px-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {loadingList && sessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-zinc-400 font-mono">
                    Consultando enlaces activos de {regionLabel}...
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-zinc-500">
                    No hay enlaces dinámicos emitidos aún para {regionLabel}.
                  </td>
                </tr>
              ) : (
                sessions.slice(0, 20).map((ses) => {
                  const st = getSessionStatus(ses, nowMs);
                  return (
                    <tr key={ses.id} className="hover:bg-white/[0.02]">
                      <td className="py-2 px-3">
                        <span className="inline-flex items-center gap-1.5 font-bold text-white">
                          {ses.rol === 'chofer' ? (
                            <Truck className="w-3.5 h-3.5 text-red-400" />
                          ) : (
                            <Smartphone className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <span>{ses.rol === 'chofer' ? 'Chofer' : 'Promotora'}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-mono font-bold text-zinc-200">{ses.ruta_codigo}</div>
                        {ses.personal_nombre && (
                          <div className="text-[11px] text-zinc-400 truncate max-w-[180px]">
                            {ses.personal_nombre}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-zinc-300 tabular-nums">
                        <div>{formatVeTimestamp(ses.expires_at)}</div>
                        <div className="text-[10px] text-zinc-500 flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          <span>
                            {st === 'ACTIVO'
                              ? formatRemainingWindow(ses.expires_at, nowMs)
                              : `${ses.duracion_horas}h`}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                            st === 'ACTIVO'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                              : st === 'REVOCADO'
                                ? 'bg-red-500/15 text-red-300 border-red-500/35'
                                : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                          }`}
                        >
                          {st}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-zinc-400">
                        {formatVeTimestamp(ses.last_used_at)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {st === 'ACTIVO' ? (
                          <button
                            type="button"
                            data-testid={`btn-revoke-shift-${ses.id}`}
                            disabled={revokingId === ses.id}
                            onClick={() => void handleRevoke(ses)}
                            className="px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600 text-red-200 hover:text-white border border-red-500/40 text-[11px] font-bold inline-flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
                          >
                            {revokingId === ses.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Ban className="w-3 h-3" />
                            )}
                            <span>Revocar</span>
                          </button>
                        ) : (
                          <span className="text-[11px] font-mono text-zinc-500">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
