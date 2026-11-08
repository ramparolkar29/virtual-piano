"""Virtual Piano: Flask server for the piano UI and its JSON API."""

from flask import Flask, Response, jsonify, render_template, request

from audio import render_performance_wav

app = Flask(__name__)

WHITE_KEY_COUNT = 14
MAX_NOTES = 500
MAX_NOTE_SECONDS = 30.0
MAX_PERFORMANCE_SECONDS = 120.0
MAX_TOTAL_NOTE_SECONDS = 240.0

KEY_MAP = {
    60: "z", 61: "s", 62: "x", 63: "d", 64: "c", 65: "v",
    66: "g", 67: "b", 68: "h", 69: "n", 70: "j", 71: "m",
    72: "q", 73: "2", 74: "w", 75: "3", 76: "e", 77: "r",
    78: "5", 79: "t", 80: "6", 81: "y", 82: "7", 83: "u",
}

PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def midi_to_frequency(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def build_notes():
    notes = []
    white_index = 0
    for midi in range(60, 84):
        is_black = midi % 12 in (1, 3, 6, 8, 10)
        note = {
            "midi": midi,
            "name": f"{PITCH_NAMES[midi % 12]}{midi // 12 - 1}",
            "frequency": round(midi_to_frequency(midi), 2),
            "key": KEY_MAP[midi],
            "black": is_black,
        }
        if is_black:
            note["left_pct"] = round((white_index - 0.3) * 100 / WHITE_KEY_COUNT, 3)
            note["width_pct"] = round(60 / WHITE_KEY_COUNT, 3)
        else:
            note["white_index"] = white_index
            white_index += 1
        notes.append(note)
    return notes


def melody(*items):
    """Expand ints (one beat) and (midi, beats) pairs into note objects."""
    notes = []
    for item in items:
        if isinstance(item, int):
            notes.append({"midi": item, "beats": 1})
        else:
            midi, beats = item
            notes.append({"midi": midi, "beats": beats})
    return notes


NOTES = build_notes()

SONGS = [
    {
        "id": "twinkle",
        "name": "Twinkle Twinkle Little Star",
        "bpm": 100,
        "notes": melody(
            60, 60, 67, 67, 69, 69, (67, 2),
            65, 65, 64, 64, 62, 62, (60, 2),
            67, 67, 65, 65, 64, 64, (62, 2),
            67, 67, 65, 65, 64, 64, (62, 2),
            60, 60, 67, 67, 69, 69, (67, 2),
            65, 65, 64, 64, 62, 62, (60, 2),
        ),
    },
    {
        "id": "ode-to-joy",
        "name": "Ode to Joy",
        "bpm": 110,
        "notes": melody(
            64, 64, 65, 67, 67, 65, 64, 62,
            60, 60, 62, 64, (64, 1.5), (62, 0.5), (62, 2),
        ),
    },
    {
        "id": "happy-birthday",
        "name": "Happy Birthday",
        "bpm": 100,
        "notes": melody(
            (67, 0.75), (67, 0.25), 69, 67, 72, (71, 2),
            (67, 0.75), (67, 0.25), 69, 67, 74, (72, 2),
            (67, 0.75), (67, 0.25), 79, 76, 72, 74, (71, 2),
            (77, 0.75), (77, 0.25), 76, 72, 74, (72, 2),
        ),
    },
]


@app.get("/")
def index():
    return render_template("index.html", notes=NOTES, white_count=WHITE_KEY_COUNT)


@app.get("/api/health")
def health():
    return jsonify(status="ok", notes=len(NOTES), songs=len(SONGS))


@app.get("/api/notes")
def notes():
    return jsonify(NOTES)


@app.get("/api/songs")
def songs():
    return jsonify(SONGS)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _read_note(raw, index):
    if not isinstance(raw, dict):
        raise ValueError(f"Note {index + 1} must be an object.")

    midi = raw.get("midi")
    if not _is_number(midi) or int(midi) != midi or not 21 <= midi <= 108:
        raise ValueError(f"Note {index + 1}: 'midi' must be an integer between 21 and 108.")

    start = raw.get("start")
    if not _is_number(start) or start < 0:
        raise ValueError(f"Note {index + 1}: 'start' must be a non-negative number.")

    duration = raw.get("duration")
    if not _is_number(duration) or not 0 < duration <= MAX_NOTE_SECONDS:
        raise ValueError(
            f"Note {index + 1}: 'duration' must be between 0 and {MAX_NOTE_SECONDS:.0f} seconds."
        )

    velocity = raw.get("velocity", 0.8)
    if not _is_number(velocity) or not 0 < velocity <= 1:
        raise ValueError(f"Note {index + 1}: 'velocity' must be between 0 and 1.")

    if start + duration > MAX_PERFORMANCE_SECONDS:
        raise ValueError(
            f"Note {index + 1}: performance cannot exceed {MAX_PERFORMANCE_SECONDS:.0f} seconds."
        )

    return {
        "midi": int(midi),
        "start": float(start),
        "duration": float(duration),
        "velocity": float(velocity),
    }


@app.post("/api/render")
def render():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("notes"), list):
        return jsonify(
            error='Send JSON like {"notes": [{"midi": 60, "start": 0, "duration": 0.5}]}.'
        ), 400

    raw_notes = payload["notes"]
    if not raw_notes:
        return jsonify(error="Add at least one note."), 400
    if len(raw_notes) > MAX_NOTES:
        return jsonify(error=f"At most {MAX_NOTES} notes per request."), 400

    try:
        events = [_read_note(raw, index) for index, raw in enumerate(raw_notes)]
        total_seconds = sum(event["duration"] for event in events)
        if total_seconds > MAX_TOTAL_NOTE_SECONDS:
            raise ValueError(
                f"Total note length must stay under {MAX_TOTAL_NOTE_SECONDS:.0f} seconds."
            )
    except ValueError as error:
        return jsonify(error=str(error)), 400

    wav_bytes = render_performance_wav(events)
    return Response(
        wav_bytes,
        mimetype="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="virtual-piano-take.wav"'},
    )


if __name__ == "__main__":
    app.run(debug=True)
