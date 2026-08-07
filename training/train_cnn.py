"""
Trains the EchoSense 1D CNN obstacle classifier on the synthetic dataset
(and, once collected, real samples exported from the web app's /dataset
page). Saves a Keras model and exports it to TensorFlow.js format for
in-browser inference.

Usage:
    .venv/Scripts/python.exe train_cnn.py [--real path/to/real_dataset.json]
"""

import argparse
import json
import sys

import numpy as np
import tensorflow as tf
from sklearn.model_selection import train_test_split

from features import batch_extract_features, FEATURE_LEN
from simulate import (
    LABELS,
    SAMPLE_RATE,
    CHIRP_DELAY_S,
    build_dataset,
    generate_chirp,
)


def load_real_dataset(path):
    with open(path) as f:
        samples = json.load(f)
    X, y = [], []
    for s in samples:
        if s["label"] not in LABELS:
            continue
        X.append(np.array(s["waveform"], dtype=np.float32))
        y.append(LABELS.index(s["label"]))
    return np.array(X), np.array(y)


def build_model(input_len, n_classes):
    inputs = tf.keras.Input(shape=(input_len, 1))
    x = inputs
    for filters, kernel in [(16, 9), (32, 7), (64, 5)]:
        x = tf.keras.layers.Conv1D(filters, kernel, padding="same")(x)
        x = tf.keras.layers.BatchNormalization()(x)
        x = tf.keras.layers.ReLU()(x)
        x = tf.keras.layers.MaxPooling1D(2)(x)
    x = tf.keras.layers.GlobalAveragePooling1D()(x)
    x = tf.keras.layers.Dense(32, activation="relu")(x)
    x = tf.keras.layers.Dropout(0.3)(x)
    outputs = tf.keras.layers.Dense(n_classes, activation="softmax")(x)
    model = tf.keras.Model(inputs, outputs)
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", help="Path to real dataset JSON exported from /dataset")
    parser.add_argument("--samples-per-label", type=int, default=400)
    parser.add_argument("--epochs", type=int, default=30)
    args = parser.parse_args()

    print("Generating synthetic dataset...")
    X_raw, y, _ = build_dataset(samples_per_label=args.samples_per_label)

    if args.real:
        print(f"Loading real dataset from {args.real}...")
        X_real_raw, y_real = load_real_dataset(args.real)
        print(f"  {len(X_real_raw)} real samples loaded")
        X_raw = np.concatenate([X_raw, X_real_raw], axis=0)
        y = np.concatenate([y, y_real], axis=0)

    chirp = generate_chirp(SAMPLE_RATE)
    chirp_start_sample = round(CHIRP_DELAY_S * SAMPLE_RATE)
    print("Extracting cross-correlation features...")
    X = batch_extract_features(X_raw, chirp, chirp_start_sample)
    X = X[..., np.newaxis]  # (n, FEATURE_LEN, 1)

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    model = build_model(FEATURE_LEN, len(LABELS))
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_accuracy", mode="max", patience=12, restore_best_weights=True
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_accuracy", mode="max", factor=0.5, patience=5, min_lr=1e-5
        ),
    ]

    history = model.fit(
        X_train,
        y_train,
        validation_data=(X_val, y_val),
        epochs=args.epochs,
        batch_size=32,
        callbacks=callbacks,
        verbose=2,
    )

    val_loss, val_acc = model.evaluate(X_val, y_val, verbose=0)
    print(f"\nFinal validation accuracy: {val_acc:.3f} (loss {val_loss:.3f})")

    y_pred = np.argmax(model.predict(X_val, verbose=0), axis=1)
    print("\nPer-class accuracy:")
    for idx, label in enumerate(LABELS):
        mask = y_val == idx
        if mask.sum() == 0:
            continue
        acc = (y_pred[mask] == idx).mean()
        print(f"  {label:10s}: {acc:.3f} ({mask.sum()} samples)")

    model.save("training/models/echosense_cnn.keras")
    with open("training/models/labels.json", "w") as f:
        json.dump(LABELS, f)
    print("\nSaved model to training/models/echosense_cnn.keras")


if __name__ == "__main__":
    sys.exit(main())
