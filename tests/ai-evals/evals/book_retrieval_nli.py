"""Pinned local passage/claim comparison used only by the retrieval evaluation."""
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

CALIBRATION = Path(__file__).resolve().parents[1] / "fixtures" / "book-retrieval-nli-calibration.json"
WEIGHTS = "model_quantized.onnx"
NLI_MODELS = {
    "55614f3c7da74184742eaa0006b978744437aa91de9ba4913db42f94d7844a8f": {
        "revision": "ca5daf3d11b6c4b3143b1f4602a2edfb64c3ad7e",
        "tokenizer.json": "d0091a328b3441d754e481db5a390d7f3b8dabc6016869fd13ba350d23ddc4cd",
        "config.json": "3ebbbdf3c3803649b49715fd169207c0f42c4250dfea5dd304b1d8b8f745852a",
    },
    "18307c3bcb5d896a624c077af061b259d341829f3d13c8b3d49a044e28d4fe6a": {
        "revision": "b5113eb38ab63efdd7f280f8c144ea8b13f978ce",
        "tokenizer.json": "e23095eb61ba944c7be3a5d3e8ec19e37ce7ced0daa03550bde03e83c21b3f8a",
        "config.json": "bc7b85f164a17c1b007d87fb99d3676f4a4d2e6511d2288dd3f5334dc0f34e6b",
    },
}

class LocalEvidenceCheck:
    def __init__(self, directory):
        with (directory / WEIGHTS).open("rb") as stream:
            model = NLI_MODELS.get(hashlib.file_digest(stream, "sha256").hexdigest())
        if model is None:
            raise ValueError("NLI weights do not match a pinned model")
        self.revision = model["revision"]
        for filename in ("tokenizer.json", "config.json"):
            digest = model[filename]
            with (directory / filename).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                    raise ValueError(f"Unexpected NLI file digest: {filename}")
        config = json.loads((directory / "config.json").read_text())
        self.labels = [config["id2label"][str(index)] for index in range(3)]
        self.entailment = self.labels.index("entailment")
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        pad_id = config["pad_token_id"]
        self.tokenizer.enable_padding(pad_id=pad_id, pad_token=self.tokenizer.id_to_token(pad_id))
        self.tokenizer.enable_truncation(max_length=512)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(directory / WEIGHTS), sess_options=options, providers=["CPUExecutionProvider"],
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

    def classify(self, passages, claim):
        if not passages:
            return []
        encoded = self.tokenizer.encode_batch([(passage, claim) for passage in passages])
        inputs = {
            "input_ids": np.asarray([item.ids for item in encoded], dtype=np.int64),
            "attention_mask": np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
            "token_type_ids": np.asarray([item.type_ids for item in encoded], dtype=np.int64),
        }
        logits, *_ = self.session.run(None, {name: inputs[name] for name in self.input_names})
        scores = np.exp(logits - logits.max(axis=1, keepdims=True))
        probabilities = scores / scores.sum(axis=1, keepdims=True)
        return [
            {
                "label": self.labels[int(np.argmax(row))],
                "entailment": float(row[self.entailment]),
            }
            for row in probabilities
        ]

    def calibration(self):
        rows = json.loads(CALIBRATION.read_text(encoding="utf-8"))
        decisions = [
            (supported, self.classify([passage], claim)[0])
            for passage, claim, supported in rows
        ]
        threshold = max(row["entailment"] for supported, row in decisions if not supported)
        return {
            "strictlyAbove": threshold,
            "supportedPairs": sum(supported for supported, _ in decisions),
            "supportedAboveCutoff": sum(
                supported and row["label"] == "entailment" and row["entailment"] > threshold
                for supported, row in decisions
            ),
            "unsupportedPairs": sum(not supported for supported, _ in decisions),
        }
