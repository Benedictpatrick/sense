"""
Trains the GestureTalk ASL-alphabet fingerspelling CNN on real public data
(Sign Language MNIST — 28x28 grayscale hand images, 24 static letters;
J and Z are excluded upstream since they require motion). This is the
"fallback" recognizer alongside the geometric word-gesture rules
(src/lib/gestureRules.ts): reliable, real image data, no synthetic
fabrication.

Uses tf_keras (Keras 2 API) directly, not tf.keras (Keras 3) -- Keras 3's
model_config JSON isn't understood by tensorflowjs's browser-side loader
(see training/train_cnn.py for the full story of that bug).

Usage:
    .venv/Scripts/python.exe train_gesture_cnn.py
"""

import string
import sys

import numpy as np
import pandas as pd
import tf_keras as keras
from sklearn.model_selection import train_test_split

# Raw dataset labels are 0-25 mapping to A-Z, with J(9) and Z(25) absent
# (they require motion, not a static handshape).
RAW_LABEL_TO_LETTER = {i: letter for i, letter in enumerate(string.ascii_uppercase)}


def load_split(path):
    df = pd.read_csv(path)
    y_raw = df["label"].to_numpy()
    X = df.drop(columns=["label"]).to_numpy(dtype=np.float32).reshape(-1, 28, 28, 1) / 255.0
    return X, y_raw


def build_label_mapping(y_raw_train):
    present = sorted(set(y_raw_train.tolist()))
    letters = [RAW_LABEL_TO_LETTER[r] for r in present]
    raw_to_dense = {r: i for i, r in enumerate(present)}
    return letters, raw_to_dense


def build_model(n_classes):
    inputs = keras.Input(shape=(28, 28, 1))
    x = inputs
    for filters in (32, 64):
        x = keras.layers.Conv2D(filters, 3, padding="same", activation="relu")(x)
        x = keras.layers.BatchNormalization()(x)
        x = keras.layers.MaxPooling2D(2)(x)
    x = keras.layers.GlobalAveragePooling2D()(x)
    x = keras.layers.Dense(64, activation="relu")(x)
    x = keras.layers.Dropout(0.3)(x)
    outputs = keras.layers.Dense(n_classes, activation="softmax")(x)
    model = keras.Model(inputs, outputs)
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    return model


def main():
    print("Loading Sign Language MNIST...")
    X_train_full, y_train_raw = load_split("training/data/sign_mnist/train.csv")
    X_test, y_test_raw = load_split("training/data/sign_mnist/test.csv")

    letters, raw_to_dense = build_label_mapping(y_train_raw)
    print(f"Classes ({len(letters)}): {''.join(letters)}")

    y_train_full = np.array([raw_to_dense[r] for r in y_train_raw])
    y_test = np.array([raw_to_dense[r] for r in y_test_raw if r in raw_to_dense])
    X_test = X_test[np.isin(y_test_raw, list(raw_to_dense.keys()))]

    X_train, X_val, y_train, y_val = train_test_split(
        X_train_full, y_train_full, test_size=0.1, random_state=42, stratify=y_train_full
    )

    model = build_model(len(letters))
    model.summary()

    callbacks = [
        keras.callbacks.EarlyStopping(monitor="val_accuracy", mode="max", patience=5, restore_best_weights=True),
    ]

    model.fit(
        X_train,
        y_train,
        validation_data=(X_val, y_val),
        epochs=20,
        batch_size=64,
        callbacks=callbacks,
        verbose=2,
    )

    test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)
    print(f"\nHeld-out test accuracy (real Kaggle test split): {test_acc:.3f} (loss {test_loss:.3f})")

    model.save("training/models/gesture_alphabet_cnn.h5")
    import json

    with open("training/models/gesture_alphabet_labels.json", "w") as f:
        json.dump(letters, f)
    print("\nSaved model to training/models/gesture_alphabet_cnn.h5")


if __name__ == "__main__":
    sys.exit(main())
