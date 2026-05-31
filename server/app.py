# import soundcard as sc
# import numpy as np
# import speech_recognition as sr
# from deep_translator import GoogleTranslator
# import wave
# import tempfile
# import os

# recognizer = sr.Recognizer()

# # --------------------------------
# # FOLDERS
# # --------------------------------
# TRANSCRIBE_FOLDER = "transcribe"
# RECORD_FOLDER = "Record"

# os.makedirs(
#     TRANSCRIBE_FOLDER,
#     exist_ok=True
# )

# os.makedirs(
#     RECORD_FOLDER,
#     exist_ok=True
# )

# # --------------------------------
# # CREATE NEW FILE NAME
# # --------------------------------

# def get_current_file():

#     session_file = "current_session.txt"

#     if not os.path.exists(session_file):

#         return None

#     with open(
#         session_file,
#         "r",
#         encoding="utf-8"
#     ) as f:

#         filename = f.read().strip()

#     return os.path.join(
#         TRANSCRIBE_FOLDER,
#         filename
#     )

# #---------------------------------
# #Save Audio
# #---------------------------------
# def get_current_record_file():

#     session_file = "current_session.txt"

#     if not os.path.exists(session_file):
#         return None

#     with open(
#         session_file,
#         "r",
#         encoding="utf-8"
#     ) as f:

#         transcript_filename = f.read().strip()

#     record_filename = transcript_filename.replace(
#         "transcript_",
#         "recording_"
#     ).replace(
#         ".txt",
#         ".wav"
#     )

#     return os.path.join(
#         RECORD_FOLDER,
#         record_filename
#     )

# def append_to_recording(
#     audio_data,
#     sample_rate
# ):

#     record_file = get_current_record_file()

#     if not record_file:
#         return

#     audio_data = (
#         audio_data * 32767
#     ).astype(np.int16)

#     if not os.path.exists(record_file):

#         with wave.open(
#             record_file,
#             "wb"
#         ) as wf:

#             wf.setnchannels(2)
#             wf.setsampwidth(2)
#             wf.setframerate(sample_rate)

#             wf.writeframes(
#                 audio_data.tobytes()
#             )

#     else:

#         with wave.open(
#             record_file,
#             "rb"
#         ) as existing:

#             old_frames = existing.readframes(
#                 existing.getnframes()
#             )

#             channels = existing.getnchannels()
#             sampwidth = existing.getsampwidth()
#             framerate = existing.getframerate()

#         with wave.open(
#             record_file,
#             "wb"
#         ) as wf:

#             wf.setnchannels(channels)
#             wf.setsampwidth(sampwidth)
#             wf.setframerate(framerate)

#             wf.writeframes(old_frames)

#             wf.writeframes(
#                 audio_data.tobytes()
#             )

# # --------------------------------
# # RECORD SYSTEM AUDIO
# # --------------------------------
# def record_system_audio(seconds=10):

#     speaker = sc.default_speaker()

#     mic = sc.get_microphone(
#         id=str(speaker.name),
#         include_loopback=True
#     )

#     sample_rate = 48000

#     with mic.recorder(
#         samplerate=sample_rate,
#         blocksize=1024
#     ) as recorder:

#         print(
#             f"\nRecording system audio for {seconds} seconds..."
#         )

#         frames = []

#         for _ in range(
#             0,
#             int(sample_rate / 1024 * seconds)
#         ):

#             data = recorder.record(
#                 numframes=1024
#             )

#             frames.append(data)

#     return np.concatenate(frames), sample_rate

# # --------------------------------
# # SAVE WAV
# # --------------------------------
# def save_wav(data, sample_rate):

#     temp_file = tempfile.NamedTemporaryFile(
#         delete=False,
#         suffix=".wav"
#     )

#     audio_data = (
#         data * 32767
#     ).astype(np.int16)

#     with wave.open(
#         temp_file.name,
#         'w'
#     ) as wf:

#         wf.setnchannels(2)
#         wf.setsampwidth(2)
#         wf.setframerate(sample_rate)

#         wf.writeframes(
#             audio_data.tobytes()
#         )

#     return temp_file.name

# # --------------------------------
# # SPEECH TO TEXT
# # --------------------------------
# def speech_to_text(wav_file):

#     try:

#         with sr.AudioFile(wav_file) as source:

#             audio = recognizer.record(source)

#             text = recognizer.recognize_google(
#                 audio,
#                 language="hi-IN"
#             )

#             return text

#     except sr.UnknownValueError:

#         print("Could not understand audio")

#         return None

#     except sr.RequestError as e:

#         print("Google API Error:", e)

#         return None

#     except Exception as e:

#         print("Speech Error:", e)

#         return None

# # --------------------------------
# # TRANSLATE
# # --------------------------------
# def translate_to_english(text):

#     if not text:
#         return None

#     try:

#         translated = GoogleTranslator(
#             source='auto',
#             target='en'
#         ).translate(text)

#         return translated

#     except Exception as e:

#         print("Translation Error:", e)

#         return None

# # --------------------------------
# # MAIN LOOP
# # --------------------------------
# while True:

#     try:

#         current_file = get_current_file()

#         if not current_file:
#             continue

#         audio_data, sr_rate = record_system_audio(8)

#         # Save audio chunk into full session recording
#         append_to_recording(
#             audio_data,
#             sr_rate
#         )

#         wav_path = save_wav(
#             audio_data,
#             sr_rate
#         )

#         original_text = speech_to_text(
#             wav_path
#         )

#         if not original_text:
#             continue

#         print("\nOriginal:")
#         print(original_text)

#         english_text = translate_to_english(
#             original_text
#         )

#         if not english_text:
#             continue

#         print("\nEnglish:")
#         print(english_text)

#         with open(
#             current_file,
#             "a",
#             encoding="utf-8"
#         ) as f:

#             f.write(
#                 english_text + "\n"
#             )

#     except Exception as e:

#         print(
#             "Main Loop Error:",
#             e
#         )

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

# --------------------------------
# CONFIG
# --------------------------------
CLOUD_URL = "https://speechtotext-060i.onrender.com"
SESSION_ID = str(uuid.uuid4())

print(f"\nSession ID: {SESSION_ID}")
print(f"Cloud URL:  {CLOUD_URL}\n")

# --------------------------------
# REGISTER SESSION WITH RETRY
# --------------------------------
def register_session():
    for attempt in range(5):
        try:
            r = requests.post(
                f"{CLOUD_URL}/start-session",
                json={"session_id": SESSION_ID},
                timeout=30  # longer timeout — Render may be waking up
            )
            print("Session started on server.")
            return True
        except Exception as e:
            print(f"Connect attempt {attempt+1} failed: {e}")
            time.sleep(5)
    print("Could not connect after 5 attempts. Check server.")
    return False

register_session()

# --------------------------------
# RECORD SYSTEM AUDIO
# --------------------------------
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

# --------------------------------
# SAVE WAV
# --------------------------------
def save_wav(data, sample_rate):
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    audio_data = (data * 32767).astype(np.int16)
    with wave.open(temp_file.name, 'w') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_data.tobytes())
    return temp_file.name

# --------------------------------
# SPEECH TO TEXT WITH RETRY
# --------------------------------
def speech_to_text(wav_file):
    for attempt in range(3):
        try:
            with sr.AudioFile(wav_file) as source:
                audio = recognizer.record(source)
                text = recognizer.recognize_google(
                    audio,
                    language="hi-IN"
                )
                return text
        except sr.UnknownValueError:
            return None  # silence — not an error
        except sr.RequestError as e:
            print(f"Google API Error (attempt {attempt+1}): {e}")
            time.sleep(3)
        except Exception as e:
            print(f"Speech Error: {e}")
            return None
    return None

# --------------------------------
# TRANSLATE WITH RETRY
# --------------------------------
def translate_to_english(text):
    if not text:
        return None
    for attempt in range(3):
        try:
            translated = GoogleTranslator(
                source='auto',
                target='en'
            ).translate(text)
            return translated
        except Exception as e:
            print(f"Translation Error (attempt {attempt+1}): {e}")
            time.sleep(2)
    return None

# --------------------------------
# PUSH TO SERVER WITH RETRY
# --------------------------------
def push_to_server(text):
    if not text:
        return
    for attempt in range(5):
        try:
            requests.post(
                f"{CLOUD_URL}/push",
                json={
                    "session_id": SESSION_ID,
                    "text": text
                },
                timeout=30
            )
            return  # success
        except Exception as e:
            print(f"Push Error (attempt {attempt+1}): {e}")
            time.sleep(3)

# --------------------------------
# KEEP SERVER AWAKE (ping every 10 min)
# --------------------------------
last_ping = time.time()

def ping_server():
    global last_ping
    if time.time() - last_ping > 600:  # 10 minutes
        try:
            requests.get(f"{CLOUD_URL}/", timeout=10)
            last_ping = time.time()
            print("Server pinged to keep awake.")
        except:
            pass

# --------------------------------
# MAIN LOOP
# --------------------------------
print("Starting... Press Ctrl+C to stop.\n")

while True:
    try:
        ping_server()

        audio_data, sr_rate = record_system_audio(8)

        wav_path = save_wav(audio_data, sr_rate)

        original_text = speech_to_text(wav_path)

        # Cleanup temp file
        try:
            os.remove(wav_path)
        except:
            pass

        if not original_text:
            print("(silence or unclear)")
            continue

        print(f"\nOriginal: {original_text}")

        english_text = translate_to_english(original_text)

        if not english_text:
            print("Translation failed, skipping.")
            continue

        print(f"English:  {english_text}")

        push_to_server(english_text)

    except KeyboardInterrupt:
        print("\nStopped by user.")
        break

    except Exception as e:
        print(f"Main Loop Error: {e}")
        time.sleep(2)  # wait before retry instead of crashing