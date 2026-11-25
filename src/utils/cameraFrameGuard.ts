/**
 * Utilidades defensivas contra pantallas negras de cámara WebRTC y fotogramas
 * corruptos/en negro en dispositivos móviles (Android Chrome / Samsung Internet / iOS Safari).
 */

export interface VideoReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface VideoReadyResult {
  ready: boolean;
  width: number;
  height: number;
  reason?: string;
}

/**
 * Detecta si un lienzo `<canvas>` contiene un fotograma completamente negro o transparente
 * (p. ej. cámara WebRTC aún sin autoexposición o fallo de decodificación GPU en móviles).
 *
 * Muestrea una cuadrícula de 16×16 píxeles (< 0.5 ms) para no impactar teléfonos lentos.
 * Nunca lanza error si el navegador bloquea `getImageData` (entornos headless / tainted).
 */
export function isCanvasFrameSolidBlack(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return true;
  }

  try {
    const safeW = Math.max(1, Math.floor(width));
    const safeH = Math.max(1, Math.floor(height));
    const grid = 16;
    const stepX = Math.max(1, Math.floor(safeW / grid));
    const stepY = Math.max(1, Math.floor(safeH / grid));

    let totalSamples = 0;
    let darkOrBlankSamples = 0;
    let maxLuminance = 0;

    for (let y = Math.floor(stepY / 2); y < safeH; y += stepY) {
      for (let x = Math.floor(stepX / 2); x < safeW; x += stepX) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        const r = pixel[0] ?? 0;
        const g = pixel[1] ?? 0;
        const b = pixel[2] ?? 0;
        const a = pixel[3] ?? 0;

        totalSamples += 1;
        const lum = Math.max(r, g, b);
        if (a > 0 && lum > maxLuminance) {
          maxLuminance = lum;
        }
        // Píxel completamente transparente o negro puro (<= 6 en los 3 canales RGB)
        if (a < 10 || (r <= 6 && g <= 6 && b <= 6)) {
          darkOrBlankSamples += 1;
        }
      }
    }

    if (totalSamples === 0) return true;
    const darkRatio = darkOrBlankSamples / totalSamples;
    // Se considera fotograma negro/corrupto únicamente cuando prácticamente el 100 % es negro puro
    return darkRatio >= 0.99 && maxLuminance <= 10;
  } catch {
    return false;
  }
}

/**
 * Verifica que un `<video>` tenga metadatos cargados, dimensiones reales (> 0)
 * y al menos un fotograma decodificado (`readyState >= 2`).
 */
export function isVideoElementFrameReady(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return (
    video.readyState >= 2 &&
    Number.isFinite(video.videoWidth) &&
    Number.isFinite(video.videoHeight) &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

/**
 * Vincula de forma determinista un `MediaStream` a un `<video>` ya montado en el DOM,
 * forzando los atributos requeridos por iOS Safari y Android Chrome (`muted`, `playsInline`)
 * y esperando hasta que exista un fotograma real visible (evitando pantalla negra).
 */
export async function attachStreamAndWaitForVideoFrame(
  video: HTMLVideoElement,
  stream: MediaStream,
  options?: VideoReadyOptions,
): Promise<VideoReadyResult> {
  const timeoutMs = options?.timeoutMs ?? 4000;
  const pollIntervalMs = options?.pollIntervalMs ?? 80;

  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  try {
    await video.play();
  } catch {
    // Algunos navegadores permiten play() inmediatamente tras loadedmetadata
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // Verificar que al menos una pista de video siga viva
    const tracks = stream.getVideoTracks();
    const hasLiveTrack = tracks.some((t) => t.readyState === 'live');
    if (tracks.length > 0 && !hasLiveTrack) {
      return { ready: false, width: 0, height: 0, reason: 'La pista de cámara se detuvo inesperadamente.' };
    }

    if (isVideoElementFrameReady(video)) {
      if (video.paused) {
        await video.play().catch(() => undefined);
      }
      return { ready: true, width: video.videoWidth, height: video.videoHeight };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    ready: isVideoElementFrameReady(video),
    width: video.videoWidth || 0,
    height: video.videoHeight || 0,
    reason: 'La cámara no devolvió imagen a tiempo. Usa "Cámara Nativa" para capturar sin fallos.',
  };
}

/**
 * Solicita acceso a la cámara trasera/frontal usando una cadena progresiva de restricciones
 * compatibles con Android Camera HAL (evita relaciones portrait forzadas que congelan en negro)
 * y iOS Safari.
 */
export async function requestResilientCameraStream(
  facingMode: 'user' | 'environment',
): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Tu navegador no soporta cámara integrada (getUserMedia).');
  }

  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
      audio: false,
    },
    {
      video: {
        facingMode: { ideal: facingMode },
      },
      audio: false,
    },
    {
      video: true,
      audio: false,
    },
  ];

  let lastErr: unknown = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0 && videoTracks.some((t) => t.readyState === 'live')) {
        return stream;
      }
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      lastErr = err;
      // Si el usuario denegó permiso explícitamente, no insistir con más intentos
      if (
        err instanceof Error &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ) {
        throw err;
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error('No se pudo iniciar el video de la cámara integrada.');
}
