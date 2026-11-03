// Key presets for the dashboard's "Add key" (and the env file import). Most are OpenAI-compatible: a base URL and a
// free default model; the admin can change the model on any key. Order here = the default chain order for imports.
export const PRESETS = [
  { id: 'gemini', label: 'Gemini', kind: 'gemini', env: ['GEMINI_API_KEY'], model: '', help: 'Free key: aistudio.google.com/apikey' },
  { id: 'groq', label: 'Groq', kind: 'openai', env: ['GROQ_API_KEY'], base_url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', help: 'Free key: console.groq.com/keys' },
  { id: 'cloudflare', label: 'Cloudflare Workers AI', kind: 'cloudflare', env: ['CLOUDFLARE_API_TOKEN'], help: 'Account ID + API token (Workers AI: Read) from dash.cloudflare.com' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', env: ['OPENROUTER_API_KEY'], base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b:free', help: 'Free models end in :free. Key: openrouter.ai/keys' },
  { id: 'mistral', label: 'Mistral', kind: 'openai', env: ['MISTRAL_API_KEY'], base_url: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', help: 'Free "Experiment" plan key: console.mistral.ai' },
  { id: 'cerebras', label: 'Cerebras', kind: 'openai', env: ['CEREBRAS_API_KEY'], base_url: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', help: 'Free key: cloud.cerebras.ai' },
  { id: 'github', label: 'GitHub Models', kind: 'openai', env: ['GITHUB_MODELS_TOKEN'], base_url: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', help: 'A GitHub token with the "models" permission' },
  { id: 'cohere', label: 'Cohere', kind: 'openai', env: ['COHERE_API_KEY'], base_url: 'https://api.cohere.ai/compatibility/v1', model: 'command-a-03-2025', help: 'Free trial key: dashboard.cohere.com/api-keys' },
  { id: 'huggingface', label: 'Hugging Face', kind: 'openai', env: ['HF_TOKEN'], base_url: 'https://router.huggingface.co/v1', model: 'openai/gpt-oss-120b', help: 'Token with "Inference Providers" permission: huggingface.co/settings/tokens' },
  { id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai', env: ['NVIDIA_API_KEY'], base_url: 'https://integrate.api.nvidia.com/v1', model: 'openai/gpt-oss-120b', help: 'Free key: build.nvidia.com' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', kind: 'openai', env: [], base_url: '', model: '', help: 'Any OpenAI-compatible server: its base URL (ends in /v1) and a model name' },
];
export function presetFor(baseUrl, kind) {
  if (kind === 'gemini') return 'gemini';
  if (kind === 'cloudflare') return 'cloudflare';
  const b = String(baseUrl || '').replace(/\/+$/, '').toLowerCase();
  const p = PRESETS.find(x => x.base_url && b === x.base_url.toLowerCase());
  return p ? p.id : 'custom';
}
