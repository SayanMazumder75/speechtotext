import soundcard as sc
import numpy as np
import speech_recognition as sr
from deep_translator import GoogleTranslator
import wave
import tempfile
import os
import requests
import uuid
import time

recognizer = sr.Recognizer()

CLOUD_URL = "https://speechtotext-060i.onrender.com"
SESSION_ID = str(uuid.uuid4())

INPUT_LANG = "bn-IN"   # bn-IN, hi-IN, en-IN
TARGET_LANG = "en"

print(f"\nSession ID: {SESSION_ID}")
print(f"Cloud URL: {CLOUD_URL}")
print(f"Input language: {INPUT_LANG}\n")


def register_session():
    for attempt in range(5):
        try:
            requests.post(
                f"{CLOUD_URL}/start-session",
                json={
                    "session_id": SESSION_ID,
                    "language": INPUT_LANG
                },
                timeout=30
            )
            print("Session started on server.")
            return True
        except Exception as e:
            print(f"Connect attempt {attempt + 1} failed: {e}")
            time.sleep(5)

    print("Could not connect after 5 attempts. Check server.")
    return False


def record_system_audio(seconds=8):
    speaker = sc.default_speaker()
    mic = sc.get_microphone(
        id=str(speaker.name),
        include_loopback=True
    )
    sample_rate = 48000

    with mic.recorder(samplerate=sample_rate, blocksize=1024) as recorder:
        print(f"\nRecording {seconds}s...")
        frames = []
        for _ in range(int(sample_rate / 1024 * seconds)):
            data = recorder.record(numframes=1024)
            frames.append(data)

    return np.concatenate(frames), sample_rate


def save_wav(data, sample_rate):
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    audio_data = (data * 32767).astype(np.int16)

    with wave.open(temp_file.name, "w") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_data.tobytes())

    return temp_file.name


def speech_to_text(wav_file):
    for attempt in range(3):
        try:
            with sr.AudioFile(wav_file) as source:
                audio = recognizer.record(source)
                text = recognizer.recognize_google(
                    audio,
                    language=INPUT_LANG
                )
                return text

        except sr.UnknownValueError:
            return None

        except sr.RequestError as e:
            print(f"Google API Error (attempt {attempt + 1}): {e}")
            time.sleep(3)

        except Exception as e:
            print(f"Speech Error: {e}")
            return None

    return None


def translate_to_english(text):
    if not text:
        return None

    if INPUT_LANG.startswith("en"):
        return text

    for attempt in range(3):
        try:
            translated = GoogleTranslator(
                source="auto",
                target=TARGET_LANG
            ).translate(text)
            return translated
        except Exception as e:
            print(f"Translation Error (attempt {attempt + 1}): {e}")
            time.sleep(2)

    return None


def push_to_server(text):
    if not text:
        return

    payload = text
    if not text.startswith("[SYSTEM] "):
        payload = f"[SYSTEM] {text}"

    for attempt in range(5):
        try:
            requests.post(
                f"{CLOUD_URL}/push",
                json={
                    "session_id": SESSION_ID,
                    "text": payload
                },
                timeout=30
            )
            return
        except Exception as e:
            print(f"Push Error (attempt {attempt + 1}): {e}")
            time.sleep(3)


last_ping = time.time()


def ping_server():
    global last_ping
    if time.time() - last_ping > 600:
        try:
            requests.get(f"{CLOUD_URL}/", timeout=10)
            last_ping = time.time()
            print("Server pinged to keep awake.")
        except Exception:
            pass


if register_session():
    print("Starting... Press Ctrl+C to stop.\n")

    while True:
        try:
            ping_server()

            audio_data, sr_rate = record_system_audio(8)
            wav_path = save_wav(audio_data, sr_rate)

            original_text = speech_to_text(wav_path)

            try:
                os.remove(wav_path)
            except Exception:
                pass

            if not original_text:
                print("(silence or unclear)")
                continue

            print(f"\nOriginal: {original_text}")

            english_text = translate_to_english(original_text)

            if not english_text:
                print("Translation failed, skipping.")
                continue

            print(f"English: {english_text}")

            push_to_server(english_text)

        except KeyboardInterrupt:
            print("\nStopped by user.")
            break

        except Exception as e:
            print(f"Main Loop Error: {e}")
            time.sleep(2)