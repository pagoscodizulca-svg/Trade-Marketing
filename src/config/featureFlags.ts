/**
 * Banderas de características (Feature Flags) del Módulo 1 (`Promotoras y Fuerza de Ventas`).
 *
 * REGLA DE ARQUITECTURA:
 * - Mantener en `false` para desactivar y ocultar los controles y tablas sobrantes del Módulo 1
 *   sin eliminar los componentes, modales ni servicios originales del repositorio.
 * - Cuando `ENABLE_MODULO1_TABLAS_METRICAS` está en `false`, también se omiten las consultas
 *   y efectos exclusivos de esas métricas hacia Supabase.
 */
export type FeatureFlagKey =
  | 'ENABLE_MODULO1_CARGAR_ARCHIVO'
  | 'ENABLE_MODULO1_ENVIAR_SOLICITUD_FDV'
  | 'ENABLE_MODULO1_CICLO_ISO_BADGE'
  | 'ENABLE_MODULO1_TABLAS_METRICAS';

export const FEATURE_FLAGS: Readonly<Record<FeatureFlagKey, boolean>> = {
  /** Botón y modal "Cargar Archivo (Excel / CSV / PDF)" en Módulo 1 */
  ENABLE_MODULO1_CARGAR_ARCHIVO: false,
  /** Botón y modal "+ Enviar Solicitud FDV" en Módulo 1 */
  ENABLE_MODULO1_ENVIAR_SOLICITUD_FDV: false,
  /** Indicador y lógica rígida de corte por "Ciclo ISO (Lunes - Domingo · UTC-4)" en Módulo 1 */
  ENABLE_MODULO1_CICLO_ISO_BADGE: false,
  /** Tarjetas y tablas de métricas 360° del Módulo 1 + consultas exclusivas asociadas */
  ENABLE_MODULO1_TABLAS_METRICAS: false,
};
