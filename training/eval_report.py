import numpy as np
import tensorflow as tf
from sklearn.model_selection import train_test_split
from sklearn.metrics import confusion_matrix, classification_report

from features import batch_extract_features, FEATURE_LEN
from simulate import LABELS, SAMPLE_RATE, CHIRP_DELAY_S, build_dataset, generate_chirp

X_raw, y, _ = build_dataset(samples_per_label=400, seed=42)
chirp = generate_chirp(SAMPLE_RATE)
chirp_start_sample = round(CHIRP_DELAY_S * SAMPLE_RATE)
X = batch_extract_features(X_raw, chirp, chirp_start_sample)[..., np.newaxis]

_, X_val, _, y_val = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

model = tf.keras.models.load_model("training/models/echosense_cnn.keras")
y_pred = np.argmax(model.predict(X_val, verbose=0), axis=1)

print("Confusion matrix (rows=true, cols=pred):")
cm = confusion_matrix(y_val, y_pred)
print("          " + " ".join(f"{l:>8s}" for l in LABELS))
for i, row in enumerate(cm):
    print(f"{LABELS[i]:>9s} " + " ".join(f"{v:>8d}" for v in row))

print()
print(classification_report(y_val, y_pred, target_names=LABELS, digits=3))
