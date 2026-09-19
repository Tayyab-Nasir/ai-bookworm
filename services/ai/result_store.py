"""Service-only metadata receipts. Unknown reservations never regenerate."""
import os
import httpx


class ReceiptUnavailable(RuntimeError):
    pass


class ReceiptConflict(RuntimeError):
    pass


class MetadataResultStore:
    def __init__(self):
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key or not os.environ.get("AI_SERVICE_TOKEN"):
            raise ReceiptUnavailable("Metadata receipt storage and service authentication must be configured.")

    def _request(self, method, *, params=None, payload=None):
        try:
            with httpx.Client(timeout=15, follow_redirects=False) as client:
                return client.request(method, self.url + "/rest/v1/metadata_service_receipts",
                    params=params, json=payload, headers={"apikey": self.key,
                        "authorization": "Bearer " + self.key, "prefer": "return=representation"})
        except httpx.HTTPError as exc:
            raise ReceiptUnavailable("Metadata receipt storage is unavailable.") from exc

    def _row(self, job_id):
        response = self._request("GET", params={"job_id": "eq." + str(job_id),
                                                "select": "request_sha256,result_json", "limit": "1"})
        if response.status_code != 200:
            raise ReceiptUnavailable("Metadata receipt storage is unavailable.")
        try:
            rows = response.json()
            if not isinstance(rows, list) or (rows and not isinstance(rows[0], dict)):
                raise ValueError("Invalid receipt")
            return rows[0] if rows else None
        except (ValueError, TypeError) as exc:
            raise ReceiptUnavailable("Metadata receipt storage returned invalid data.") from exc

    def reserve(self, job_id, fingerprint):
        response = self._request("POST", payload={"job_id": str(job_id), "request_sha256": fingerprint})
        if response.status_code == 201:
            return None
        if response.status_code != 409:
            raise ReceiptUnavailable("Could not reserve metadata generation. No generation was started.")
        row = self._row(job_id)
        if not row or row.get("request_sha256") != fingerprint:
            raise ReceiptConflict("Metadata job ID is already bound to a different request.")
        if not isinstance(row.get("result_json"), dict):
            raise ReceiptConflict("Metadata generation is unresolved. Recover its result; do not regenerate.")
        return row["result_json"]

    def save(self, job_id, fingerprint, result):
        response = self._request("PATCH", params={"job_id": "eq." + str(job_id),
            "request_sha256": "eq." + fingerprint, "result_json": "is.null"}, payload={"result_json": result})
        if response.status_code != 200:
            raise ReceiptUnavailable("Could not confirm the saved metadata result. Recover this request before retrying.")
        try:
            rows = response.json()
            if not isinstance(rows, list) or len(rows) != 1:
                raise ValueError("Receipt was not updated")
        except (ValueError, TypeError) as exc:
            raise ReceiptUnavailable("Could not confirm the saved metadata result.") from exc

    def load(self, job_id):
        row = self._row(job_id)
        return row.get("result_json") if row else None
