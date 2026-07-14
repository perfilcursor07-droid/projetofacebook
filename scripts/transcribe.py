#!/usr/bin/env python3
"""
Transcrição local gratuita via faster-whisper.
Uso: python scripts/transcribe.py <caminho_audio.wav>
Saída JSON no stdout: { "text", "language", "segments" }
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Informe o caminho do arquivo de áudio"}))
        return 1

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "faster-whisper não instalado. Rode: pip install -r scripts/requirements.txt"
                }
            )
        )
        return 1

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

        def run_transcribe(vad: bool, language: str | None):
            segments_iter, info = model.transcribe(
                audio_path,
                beam_size=5,
                vad_filter=vad,
                language=language,
            )
            segments = []
            texts = []
            for seg in segments_iter:
                piece = (seg.text or "").strip()
                if not piece:
                    continue
                texts.append(piece)
                segments.append(
                    {
                        "start": round(float(seg.start), 2),
                        "end": round(float(seg.end), 2),
                        "text": piece,
                    }
                )
            return " ".join(texts).strip(), getattr(info, "language", None), segments

        # 1ª tentativa: português + VAD (mais preciso para conteúdo BR)
        text, language, segments = run_transcribe(True, "pt")
        # 2ª: sem VAD (alguns áudios baixos são cortados pelo filtro)
        if not text:
            text, language, segments = run_transcribe(False, "pt")
        # 3ª: detecção automática de idioma
        if not text:
            text, language, segments = run_transcribe(False, None)

        print(
            json.dumps(
                {
                    "text": text,
                    "language": language,
                    "segments": segments,
                    "empty": not bool(text),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
