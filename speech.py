import os
import datetime
import speech_recognition as sr
from deep_translator import GoogleTranslator
import pyttsx3

# -----------------------------
# INITIALIZE
# -----------------------------
r = sr.Recognizer()

engine = pyttsx3.init()

# -----------------------------
# CREATE TRANSCRIBE FOLDER
# -----------------------------
TRANSCRIBE_FOLDER = "transcribe"

os.makedirs(
    TRANSCRIBE_FOLDER,
    exist_ok=True
)

# -----------------------------
# CREATE UNIQUE FILE NAME
# -----------------------------
timestamp = datetime.datetime.now().strftime(
    "%Y%m%d_%H%M%S"
)

current_file = os.path.join(
    TRANSCRIBE_FOLDER,
    f"transcript_{timestamp}.txt"
)

print("\nNew Transcript File:")
print(current_file)

# -----------------------------
# RECORD AUDIO
# -----------------------------
def record_text():

    while True:

        try:

            with sr.Microphone() as source2:

                print("\nListening...")

                r.adjust_for_ambient_noise(
                    source2,
                    duration=0.5
                )

                audio2 = r.listen(source2)

                print("Recognizing...")

                text = ""

                # Bengali
                try:

                    text = r.recognize_google(
                        audio2,
                        language="bn-IN"
                    )

                # Hindi
                except:

                    try:

                        text = r.recognize_google(
                            audio2,
                            language="hi-IN"
                        )

                    # English
                    except:

                        text = r.recognize_google(
                            audio2,
                            language="en-IN"
                        )

                return text

        except sr.RequestError as e:

            print(
                "Could not request results:",
                e
            )

        except sr.UnknownValueError:

            print(
                "Could not understand audio"
            )

        except Exception as e:

            print("Error:", e)

# -----------------------------
# TRANSLATE
# -----------------------------
def translate_to_english(text):

    try:

        translated_text = GoogleTranslator(
            source='auto',
            target='en'
        ).translate(text)

        return translated_text

    except Exception as e:

        print("Translation Error:", e)

        return text

# -----------------------------
# SAVE TRANSCRIPT
# -----------------------------
def save_text(text):

    with open(
        current_file,
        "a",
        encoding="utf-8"
    ) as f:

        f.write(text)
        f.write("\n")

# -----------------------------
# SPEAK OUTPUT
# -----------------------------
def speak_text(text):

    engine.say(text)

    engine.runAndWait()

# -----------------------------
# MAIN LOOP
# -----------------------------
print("\nMultilingual Speech Translator Started")

while True:

    original_text = record_text()

    print("\nOriginal Speech:")
    print(original_text)

    english_text = translate_to_english(
        original_text
    )

    print("\nEnglish Translation:")
    print(english_text)

    # SAVE TO NEW SESSION FILE
    save_text(english_text)

    # SPEAK
    speak_text(english_text)