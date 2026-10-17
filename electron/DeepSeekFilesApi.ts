import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import axios from "axios"
import FormData from "form-data"
import { withApiCall } from "./ApiTelemetry"

export interface DeepSeekFilesConfig {
  apiKey: string
  baseURL: string
  provider: string
}

export interface DeepSeekUploadedFile {
  id: string
  filename?: string
  bytes?: number
  created_at?: number
}

function normalizedBaseURL(baseURL: string): string {
  return String(baseURL || "").trim().replace(/\/+$/, "")
}

export function supportsDeepSeekFilesApi(config: DeepSeekFilesConfig): boolean {
  if (config.provider !== "openai-compatible" || !config.apiKey) return false
  const baseURL = normalizedBaseURL(config.baseURL)
  if (!baseURL) return false
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com")
  } catch {
    return false
  }
}

function filesEndpoint(config: DeepSeekFilesConfig): string {
  const baseURL = normalizedBaseURL(config.baseURL)
  if (baseURL.toLowerCase().endsWith("/v1")) return `${baseURL.slice(0, -3)}/files`
  return `${baseURL}/files`
}

export function fileOwnerFingerprint(config: DeepSeekFilesConfig): string {
  return createHash("sha256")
    .update(`${config.provider}\n${normalizedBaseURL(config.baseURL)}\n${config.apiKey}`)
    .digest("hex")
}

export async function uploadDeepSeekImage(
  config: DeepSeekFilesConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<DeepSeekUploadedFile> {
  if (!supportsDeepSeekFilesApi(config)) throw new Error("DeepSeek Files API is not available for this provider")
  if (!fs.existsSync(filePath)) throw new Error(`Image file does not exist: ${filePath}`)

  const form = new FormData()
  form.append("purpose", "user_data")
  form.append("file", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: undefined
  })

  const response = await withApiCall(
    {
      kind: "file-upload",
      provider: config.provider,
      model: "files-api",
      baseURL: config.baseURL,
      notes: { bytes: fs.statSync(filePath).size }
    },
    async () =>
      axios.post(filesEndpoint(config), form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${config.apiKey}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000,
        signal
      }),
    (response) => ({
      content: typeof response.data?.id === "string" ? response.data.id : "",
      notes: { file_id: String(response.data?.id || "") }
    })
  )

  const id = typeof response.data?.id === "string" ? response.data.id : ""
  if (!id) throw new Error("DeepSeek Files API did not return a file id")
  return response.data as DeepSeekUploadedFile
}

export async function deleteDeepSeekFile(
  config: DeepSeekFilesConfig,
  fileId: string,
  signal?: AbortSignal
): Promise<void> {
  if (!supportsDeepSeekFilesApi(config) || !fileId) return
  await withApiCall(
    {
      kind: "file-delete",
      provider: config.provider,
      model: "files-api",
      baseURL: config.baseURL,
      notes: { file_id: fileId }
    },
    async () =>
      axios.delete(`${filesEndpoint(config)}/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeout: 30000,
        signal
      }),
    () => ({ content: "deleted" })
  )
}
