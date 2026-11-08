"use strict";

const piano = document.querySelector(".piano");
const keyElements = Array.from(piano.querySelectorAll(".key"));
const timbreSelect = document.getElementById("timbre");
const volumeInput = document.getElementById("volume");
const volumeValue = document.getElementById("volumeValue");
const songSelect = document.getElementById("song");
const playSongButton = document.getElementById("playSong");
const recordButton = document.getElementById("record");
const playTakeButton = document.getElementById("playRecording");
const downloadButton = document.getElementById("download");
const statusEl = document.getElementById("status");

const keyToMidi = new Map();
const keyByMidi = new Map();
for (const element of keyElements) {
  const midi = Number(element.dataset.midi);
  keyToMidi.set(element.dataset.key, midi);
  keyByMidi.set(midi, element);
}

const audio = { ctx: null, master: null };
const noteSources = new Map();
const activeVoices = new Map();
const scheduledVoices = new Set();
const flashTimers = new Set();

let recorder = null;
let take = [];
let songs = [];

function setStatus(message) {
  statusEl.textContent = message;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function countLabel(count) {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

function masterLevel() {
  return (Number(volumeInput.value) / 100) * 0.9;
}

function ensureAudio() {
  if (!audio.ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setStatus("This browser does not support the Web Audio API.");
      return null;
    }
    audio.ctx = new AudioContextClass();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = masterLevel();
    audio.master.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === "suspended") {
    audio.ctx.resume();
  }
  return audio.ctx;
}

function frequencyFor(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function setKeyActive(midi, active) {
  const element = keyByMidi.get(midi);
  if (element) {
    element.classList.toggle("active", active);
  }
}

function startVoice(midi, when, velocity, duration = null) {
  const ctx = audio.ctx;
  const timbre = timbreSelect.value;
  const output = ctx.createGain();
  output.connect(audio.master);

  const envelope = output.gain;
  envelope.setValueAtTime(0.0001, when);
  envelope.exponentialRampToValueAtTime(Math.max(velocity, 0.0001), when + 0.008);

  let stopAt = null;
  if (duration === null) {
    envelope.exponentialRampToValueAtTime(Math.max(velocity * 0.28, 0.0001), when + 2.6);
  } else {
    const releaseAt = when + Math.max(duration, 0.05);
    const sustain = timbre === "organ" ? velocity : Math.max(velocity * 0.3, 0.0001);
    envelope.exponentialRampToValueAtTime(sustain, releaseAt);
    envelope.exponentialRampToValueAtTime(0.0001, releaseAt + 0.16);
    stopAt = releaseAt + 0.2;
  }

  const oscillators = [];
  const frequency = frequencyFor(midi);

  if (timbre === "organ") {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(frequency, when);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(frequency * 5, 4000), when);
    filter.Q.value = 0.9;
    const level = ctx.createGain();
    level.gain.value = 0.38;
    osc.connect(filter).connect(level).connect(output);
    oscillators.push(osc);
  } else if (timbre === "sine") {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, when);
    osc.connect(output);
    oscillators.push(osc);
  } else {
    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(frequency, when);
    const bodyLevel = ctx.createGain();
    bodyLevel.gain.value = 0.85;
    body.connect(bodyLevel).connect(output);

    const shimmer = ctx.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.setValueAtTime(frequency * 2, when);
    const shimmerLevel = ctx.createGain();
    shimmerLevel.gain.value = 0.16;
    shimmer.connect(shimmerLevel).connect(output);

    oscillators.push(body, shimmer);
  }

  const voice = { output, oscillators, stopped: false };

  for (const osc of oscillators) {
    osc.start(when);
    if (stopAt !== null) {
      osc.stop(stopAt);
    }
  }

  if (duration !== null) {
    scheduledVoices.add(voice);
    oscillators[0].addEventListener("ended", () => scheduledVoices.delete(voice));
  }

  return voice;
}

function stopVoice(voice, fade = 0.14) {
  if (!voice || voice.stopped) {
    return;
  }
  voice.stopped = true;
  scheduledVoices.delete(voice);

  const now = audio.ctx.currentTime;
  const gain = voice.output.gain;
  if (typeof gain.cancelAndHoldAtTime === "function") {
    gain.cancelAndHoldAtTime(now);
  } else {
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(gain.value, 0.0001), now);
  }
  gain.exponentialRampToValueAtTime(0.0001, now + fade);

  for (const osc of voice.oscillators) {
    try {
      osc.stop(now + fade + 0.02);
    } catch (error) {
      // The oscillator was already stopped; nothing to do.
    }
  }
}

function pressNote(midi, source, velocity = 0.85) {
  let sources = noteSources.get(midi);
  if (!sources) {
    sources = new Set();
    noteSources.set(midi, sources);
  }
  if (sources.has(source)) {
    return;
  }

  const wasSilent = sources.size === 0;
  sources.add(source);
  if (!wasSilent) {
    return;
  }

  const ctx = ensureAudio();
  if (!ctx) {
    return;
  }

  activeVoices.set(midi, startVoice(midi, ctx.currentTime, velocity));
  setKeyActive(midi, true);

  if (recorder) {
    recorder.held.set(midi, performance.now() - recorder.startedAt);
  }
}

function releaseNote(midi, source) {
  const sources = noteSources.get(midi);
  if (!sources || !sources.delete(source)) {
    return;
  }
  if (sources.size > 0) {
    return;
  }

  noteSources.delete(midi);
  const voice = activeVoices.get(midi);
  if (voice) {
    stopVoice(voice);
    activeVoices.delete(midi);
  }
  setKeyActive(midi, false);

  if (recorder && recorder.held.has(midi)) {
    const start = recorder.held.get(midi);
    recorder.held.delete(midi);
    const duration = (performance.now() - recorder.startedAt - start) / 1000;
    if (duration >= 0.04) {
      recorder.events.push({
        midi,
        start: round3(start / 1000),
        duration: round3(duration),
        velocity: 0.8,
      });
      updateRecordingStatus();
    }
  }
}

function scheduleFlash(midi, delay, duration) {
  const on = setTimeout(() => setKeyActive(midi, true), delay * 1000);
  const off = setTimeout(() => {
    if (!noteSources.has(midi)) {
      setKeyActive(midi, false);
    }
  }, (delay + Math.max(duration, 0.08)) * 1000);
  flashTimers.add(on);
  flashTimers.add(off);
}

function stopScheduled() {
  for (const timer of flashTimers) {
    clearTimeout(timer);
  }
  flashTimers.clear();
  for (const voice of [...scheduledVoices]) {
    stopVoice(voice);
  }
  scheduledVoices.clear();
  for (const element of keyElements) {
    element.classList.remove("active");
  }
  for (const midi of activeVoices.keys()) {
    setKeyActive(midi, true);
  }
}

function stopAll() {
  stopScheduled();
  for (const [midi, sources] of [...noteSources]) {
    for (const source of [...sources]) {
      releaseNote(midi, source);
    }
  }
  setStatus("Stopped.");
}

function updateRecordingStatus() {
  if (!recorder) {
    return;
  }
  const seconds = (performance.now() - recorder.startedAt) / 1000;
  setStatus(`Recording ${seconds.toFixed(1)}s - ${countLabel(recorder.events.length)} captured.`);
}

function startRecording() {
  if (!ensureAudio()) {
    return;
  }
  stopScheduled();
  recorder = {
    startedAt: performance.now(),
    events: [],
    held: new Map(),
    timer: setInterval(updateRecordingStatus, 200),
  };
  recordButton.classList.add("is-recording");
  recordButton.textContent = "Stop";
  setStatus("Recording... play some notes, then stop.");
}

function stopRecording() {
  const active = recorder;
  if (!active) {
    return;
  }
  clearInterval(active.timer);

  const now = performance.now() - active.startedAt;
  for (const [midi, start] of active.held) {
    const duration = (now - start) / 1000;
    if (duration >= 0.04) {
      active.events.push({
        midi,
        start: round3(start / 1000),
        duration: round3(duration),
        velocity: 0.8,
      });
    }
  }
  active.held.clear();

  take = active.events.sort((a, b) => a.start - b.start);
  recorder = null;

  recordButton.classList.remove("is-recording");
  recordButton.textContent = "Record";
  playTakeButton.disabled = take.length === 0;
  downloadButton.disabled = take.length === 0;

  if (take.length === 0) {
    setStatus("No notes captured. Try recording again.");
    return;
  }
  const length = take.reduce((max, event) => Math.max(max, event.start + event.duration), 0);
  setStatus(`Take ready: ${countLabel(take.length)} over ${length.toFixed(1)}s.`);
}

function playTake() {
  if (!take.length) {
    return;
  }
  const ctx = ensureAudio();
  if (!ctx) {
    return;
  }
  stopScheduled();

  const lead = 0.12;
  const startAt = ctx.currentTime + lead;
  let end = 0;

  for (const event of take) {
    startVoice(event.midi, startAt + event.start, event.velocity || 0.8, event.duration);
    scheduleFlash(event.midi, lead + event.start, event.duration);
    end = Math.max(end, event.start + event.duration);
  }

  setStatus(`Playing your take (${countLabel(take.length)}).`);
  flashTimers.add(setTimeout(() => setStatus("Take finished."), (end + 0.5) * 1000));
}

async function downloadWav() {
  if (!take.length) {
    return;
  }
  downloadButton.disabled = true;
  setStatus("Rendering WAV on the server...");

  try {
    const response = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: take }),
    });

    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || `Server returned ${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "virtual-piano-take.wav";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus(`Downloaded WAV (${countLabel(take.length)}).`);
  } catch (error) {
    setStatus(`Could not render WAV: ${error.message}`);
  } finally {
    downloadButton.disabled = take.length === 0;
  }
}

async function loadSongs() {
  try {
    const response = await fetch("/api/songs");
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    songs = await response.json();
    songSelect.innerHTML = "";
    for (const song of songs) {
      const option = document.createElement("option");
      option.value = song.id;
      option.textContent = song.name;
      songSelect.append(option);
    }
    playSongButton.disabled = songs.length === 0;
  } catch (error) {
    songSelect.innerHTML = '<option value="">Songs unavailable</option>';
    playSongButton.disabled = true;
    setStatus(`Could not load songs: ${error.message}`);
  }
}

function playSelectedSong() {
  const song = songs.find((item) => item.id === songSelect.value);
  if (!song) {
    return;
  }
  const ctx = ensureAudio();
  if (!ctx) {
    return;
  }
  stopScheduled();

  const lead = 0.15;
  const beat = 60 / song.bpm;
  let cursor = 0;

  for (const note of song.notes) {
    const when = ctx.currentTime + lead + cursor * beat;
    const duration = note.beats * beat * 0.92;
    startVoice(note.midi, when, 0.85, duration);
    scheduleFlash(note.midi, lead + cursor * beat, duration);
    cursor += note.beats;
  }

  setStatus(`Playing "${song.name}".`);
  flashTimers.add(
    setTimeout(() => setStatus(`"${song.name}" finished.`), (lead + cursor * beat + 0.4) * 1000)
  );
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, select, textarea, [contenteditable='true']"))
  );
}

for (const element of keyElements) {
  const midi = Number(element.dataset.midi);

  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (element.setPointerCapture) {
      element.setPointerCapture(event.pointerId);
    }
    pressNote(midi, `pointer:${event.pointerId}`, 0.9);
  });

  const release = (event) => releaseNote(midi, `pointer:${event.pointerId}`);
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  element.addEventListener("lostpointercapture", release);
}

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (isTypingTarget(event.target)) {
    return;
  }
  if (event.key === "Escape") {
    stopAll();
    return;
  }

  const midi = keyToMidi.get(event.key.toLowerCase());
  if (midi === undefined) {
    return;
  }
  event.preventDefault();
  pressNote(midi, "keyboard", 0.8);
});

window.addEventListener("keyup", (event) => {
  const midi = keyToMidi.get(event.key.toLowerCase());
  if (midi !== undefined) {
    releaseNote(midi, "keyboard");
  }
});

window.addEventListener("blur", () => {
  for (const [midi, sources] of [...noteSources]) {
    if (sources.has("keyboard")) {
      releaseNote(midi, "keyboard");
    }
  }
});

recordButton.addEventListener("click", () => {
  if (recorder) {
    stopRecording();
  } else {
    startRecording();
  }
});

playTakeButton.addEventListener("click", playTake);
downloadButton.addEventListener("click", downloadWav);
playSongButton.addEventListener("click", playSelectedSong);

volumeInput.addEventListener("input", () => {
  volumeValue.textContent = `${volumeInput.value}%`;
  if (audio.master) {
    audio.master.gain.setTargetAtTime(masterLevel(), audio.ctx.currentTime, 0.02);
  }
});

volumeValue.textContent = `${volumeInput.value}%`;
loadSongs();
