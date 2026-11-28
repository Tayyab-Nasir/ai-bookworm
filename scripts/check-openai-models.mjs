import { pathToFileURL } from "node:url";

export async function checkOpenAIModels({ apiKey, models, fetchModels = fetch }) {
  if (!models.length || models.some(model => !/^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(model) || /^sk-/i.test(model))) {
    return { status: "invalid_model_arguments" };
  }
  if (!apiKey?.trim()) return { status: "missing_api_key" };

  try {
    const response = await fetchModels("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const expiredKey = response.status === 401 && payload?.error?.code === "expired_secret_key";
      return {
        status: expiredKey ? "expired_api_key" : "inventory_request_failed",
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    if (payload?.object !== "list" || !Array.isArray(payload.data)
      || payload.data.some(model => typeof model?.id !== "string")) {
      return { status: "invalid_inventory_response" };
    }

    const visible = new Set(payload.data.map(model => model.id));
    const missing = [...new Set(models)].filter(model => !visible.has(model));
    return missing.length ? { status: "models_missing", missing } : { status: "models_visible" };
  } catch {
    return { status: "inventory_unreachable" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkOpenAIModels({ apiKey: process.env.OPENAI_API_KEY, models: process.argv.slice(2) });
  console.log(JSON.stringify(result));
  if (result.status !== "models_visible") process.exitCode = 1;
}
