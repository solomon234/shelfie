import { useEffect, useRef, useState } from "preact/hooks";

// Camera barcode scanning with ZXing (loaded lazily; cached by the service worker for offline use).
export default function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Starting camera…");

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Camera unavailable: Shelfie must be opened over HTTPS. Enter the barcode below instead.");
        return;
      }
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]);
        const reader = new BrowserMultiFormatReader(hints);
        const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } } }, video.current!, (result) => {
          if (result && !cancelled) {
            cancelled = true;
            controls.stop();
            onCode(result.getText());
          }
        });
        stop = () => controls.stop();
        if (cancelled) controls.stop();
        else setStatus("Point the camera at a barcode.");
      } catch {
        setStatus("Camera unavailable. Allow camera access, or enter the barcode below.");
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <div class="scanner">
      <video ref={video} playsInline muted />
      <p class="muted">{status}</p>
    </div>
  );
}
