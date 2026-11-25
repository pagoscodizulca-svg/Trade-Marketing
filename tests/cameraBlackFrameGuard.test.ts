import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  attachStreamAndWaitForVideoFrame,
  isCanvasFrameSolidBlack,
  isVideoElementFrameReady,
} from '../src/utils/cameraFrameGuard';

function mockCtx(pixelRgba: [number, number, number, number]): CanvasRenderingContext2D {
  return {
    getImageData: () => ({
      data: new Uint8ClampedArray(pixelRgba),
    }),
  } as unknown as CanvasRenderingContext2D;
}

test('cameraFrameGuard: detecta fotogramas completamente negros o transparentes y acepta fotos válidas', () => {
  assert.equal(isCanvasFrameSolidBlack(mockCtx([0, 0, 0, 255]), 640, 480), true);
  assert.equal(isCanvasFrameSolidBlack(mockCtx([2, 3, 1, 255]), 640, 480), true);
  assert.equal(isCanvasFrameSolidBlack(mockCtx([0, 0, 0, 0]), 640, 480), true);
  assert.equal(isCanvasFrameSolidBlack(mockCtx([120, 95, 80, 255]), 640, 480), false);
  assert.equal(isCanvasFrameSolidBlack(mockCtx([25, 25, 25, 255]), 640, 480), false);
  assert.equal(isCanvasFrameSolidBlack(mockCtx([255, 255, 255, 255]), 0, 480), true);
});

test('cameraFrameGuard: espera a que el video entregue dimensiones reales (> 0) y readyState >= 2 antes de habilitar captura', async () => {
  const attrs: Record<string, string> = {};
  const fakeVideo = {
    muted: false,
    defaultMuted: false,
    playsInline: false,
    autoplay: false,
    paused: false,
    srcObject: null as unknown,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    setAttribute(name: string, val: string) {
      attrs[name] = val;
    },
    async play() {
      // Simular cámara móvil que tarda 60 ms en emitir su primer fotograma real
      setTimeout(() => {
        fakeVideo.readyState = 4;
        fakeVideo.videoWidth = 1280;
        fakeVideo.videoHeight = 720;
      }, 60);
    },
  };

  const fakeStream = {
    getVideoTracks: () => [{ readyState: 'live' }],
  } as unknown as MediaStream;

  assert.equal(isVideoElementFrameReady(fakeVideo as unknown as HTMLVideoElement), false);

  const res = await attachStreamAndWaitForVideoFrame(
    fakeVideo as unknown as HTMLVideoElement,
    fakeStream,
    { timeoutMs: 1000, pollIntervalMs: 20 },
  );

  assert.equal(res.ready, true);
  assert.equal(res.width, 1280);
  assert.equal(res.height, 720);
  assert.equal(fakeVideo.muted, true);
  assert.equal(fakeVideo.playsInline, true);
  assert.equal(attrs['playsinline'], 'true');
  assert.equal(attrs['webkit-playsinline'], 'true');
});

test('cameraFrameGuard: falla limpiamente si la pista de cámara muere o nunca produce fotogramas (evita pantalla negra infinita)', async () => {
  const deadVideo = {
    muted: false,
    defaultMuted: false,
    playsInline: false,
    autoplay: false,
    paused: true,
    srcObject: null as unknown,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    setAttribute() {},
    async play() {},
  };

  const deadStream = {
    getVideoTracks: () => [{ readyState: 'ended' }],
  } as unknown as MediaStream;

  const res = await attachStreamAndWaitForVideoFrame(
    deadVideo as unknown as HTMLVideoElement,
    deadStream,
    { timeoutMs: 300, pollIntervalMs: 20 },
  );

  assert.equal(res.ready, false);
  assert.ok(res.reason && res.reason.length > 0);
});

test('PortalAsistenciaTab: invariantes anti-pantalla-negra (sin race requestAnimationFrame ni stopCamera en efecto de previewUrl)', () => {
  const filePath = path.resolve('src/components/portal/PortalAsistenciaTab.tsx');
  const src = fs.readFileSync(filePath, 'utf8');

  // 1) No debe usar el antiguo patrón de carrera requestAnimationFrame(() => videoRef.current.srcObject = stream)
  assert.equal(
    /requestAnimationFrame\s*\([\s\S]{0,160}srcObject\s*=\s*stream/.test(src),
    false,
    'PortalAsistenciaTab no debe vincular videoRef.srcObject dentro de requestAnimationFrame',
  );

  // 2) Debe vincular el stream vía attachStreamAndWaitForVideoFrame y validar fotograma negro antes de aceptar captura
  assert.ok(src.includes('attachStreamAndWaitForVideoFrame'));
  assert.ok(src.includes('isCanvasFrameSolidBlack'));
  assert.ok(src.includes('requestResilientCameraStream'));

  // 3) No debe matar stopCamera() cuando solo cambia previewUrl
  assert.equal(
    /stopCamera\(\);[\s\S]{0,120}URL\.revokeObjectURL\(previewUrl\)[\s\S]{0,80}\[previewUrl,\s*stopCamera\]/.test(
      src,
    ),
    false,
    'El cleanup de previewUrl debe estar separado del cleanup de stopCamera al desmontar',
  );
});
