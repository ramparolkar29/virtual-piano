"""Offline piano synthesis: turn note events into a 16-bit mono WAV."""

import io
import math
import wave
from array import array

SAMPLE_RATE = 22050
ATTACK_SECONDS = 0.006
RELEASE_SECONDS = 0.08

# (harmonic, relative amplitude, decay multiplier)
PARTIALS = (
    (1, 1.0, 1.6),
    (2, 0.42, 0.95),
    (3, 0.2, 0.6),
    (4, 0.09, 0.4),
)


def render_performance_wav(events):
    total_seconds = max(e["start"] + e["duration"] for e in events) + RELEASE_SECONDS + 0.05
    mix = [0.0] * (int(total_seconds * SAMPLE_RATE) + 1)

    for event in events:
        _add_note(mix, event)

    peak = max(abs(sample) for sample in mix) or 1.0
    scale = 0.95 / peak if peak > 0.95 else 1.0
    pcm = array(
        "h",
        (int(max(-1.0, min(1.0, sample * scale)) * 32767) for sample in mix),
    )

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _add_note(mix, event):
    frequency = 440.0 * 2.0 ** ((event["midi"] - 69) / 12.0)
    start = int(event["start"] * SAMPLE_RATE)
    held_samples = max(1, int(event["duration"] * SAMPLE_RATE))
    release_samples = int(RELEASE_SECONDS * SAMPLE_RATE)
    velocity = event["velocity"]
    held_seconds = held_samples / SAMPLE_RATE

    for harmonic, amplitude, decay in PARTIALS:
        partial_frequency = frequency * harmonic
        if partial_frequency >= SAMPLE_RATE / 2:
            continue

        phase_step = 2.0 * math.pi * partial_frequency / SAMPLE_RATE
        decay_seconds = 1.4 * decay
        held_envelope = min(1.0, held_seconds / ATTACK_SECONDS) * math.exp(
            -held_seconds / decay_seconds
        )
        level = velocity * amplitude

        for offset in range(held_samples + release_samples):
            index = start + offset
            if index >= len(mix):
                break
            if offset < held_samples:
                envelope = min(1.0, offset / SAMPLE_RATE / ATTACK_SECONDS) * math.exp(
                    -offset / SAMPLE_RATE / decay_seconds
                )
            else:
                envelope = held_envelope * max(
                    0.0, 1.0 - (offset - held_samples) / release_samples
                )
            mix[index] += level * envelope * math.sin(phase_step * offset)
