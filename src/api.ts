import type { Message } from './types'

// 本地开发走 localhost:3000，生产/预览环境走同源 /api（由 vercel.json 反代到真实后端），避免 CORS。
// 支持通过 VITE_BACKEND_API_BASE_URL 手动覆盖
const BACKEND_API_BASE_URL =
  import.meta.env.VITE_BACKEND_API_BASE_URL ??
  (import.meta.env.DEV ? 'http://localhost:3000/api' : '/api')

function getApiRoot(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, '')
  // 兼容误配成 /api/api 的情况
  const normalized = cleaned.replace(/\/api\/api\/?$/, '/api')
  return normalized.endsWith('/api') ? normalized : `${normalized}/api`
}

const API_ROOT = getApiRoot(BACKEND_API_BASE_URL)

type ImageSize = '1024x1024' | '1024x768' | '768x1024'
type ImageStyle =
  | 'realistic'
  | 'anime'
  | 'watercolor'
  | 'oil-painting'
  | 'cyberpunk'
  | 'pixel-art'
  | '3d-cartoon'
  | 'ink-sketch'

interface GenerateImageParams {
  prompt: string
  size: ImageSize
  style: ImageStyle
}

interface ZhipuDelta {
  content?: string
}

interface ZhipuChoice {
  delta?: ZhipuDelta
  finish_reason?: string
  message?: {
    content?: string
  }
}

interface ZhipuChatStreamChunk {
  choices?: ZhipuChoice[]
}

interface ZhipuChatResponse {
  choices?: ZhipuChoice[]
}

export async function streamChatCompletion(
  messages: Message[],
  onToken: (token: string) => void,
): Promise<void> {
  const response = await fetch(`${API_ROOT}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`后端 API 请求失败（${response.status}）：${errorText}`)
  }

  // 检查响应类型
  const contentType = response.headers.get('content-type')
  
  if (contentType?.includes('text/event-stream')) {
    // 处理流式响应
    if (!response.body) {
      throw new Error('未获取到流式响应数据。')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    const parsePayload = (payload: string) => {
      if (!payload || payload === '[DONE]') return
      try {
        const chunk = JSON.parse(payload) as ZhipuChatStreamChunk
        const token = chunk.choices?.[0]?.delta?.content
        if (token) onToken(token)
      } catch {
        // Ignore malformed chunks from network boundaries.
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith('data:')) {
          parsePayload(line.slice(5).trim())
          continue
        }
        // 兼容后端或代理未按 SSE 包装、直接输出 JSON 行的情况。
        if (line.startsWith('{')) {
          parsePayload(line)
        }
      }
    }
  } else {
    // 处理非流式响应
    const data = await response.json() as ZhipuChatResponse
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('未获取到响应内容。')
    }

    // 直接一次性输出，避免DOM操作冲突
    onToken(content)
  }
}

export async function generateImage(params: GenerateImageParams): Promise<string> {
  const response = await fetch(`${API_ROOT}/image/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: params.prompt,
      size: params.size,
      style: params.style,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`图片生成失败（${response.status}）：${errorText}`)
  }

  const payload = await response.json()
  const imageUrl = payload.data?.[0]?.url
  if (!imageUrl) {
    throw new Error('未获取到有效图片地址。')
  }

  return imageUrl
}

export async function optimizeImagePrompt(params: GenerateImageParams): Promise<string> {
  const response = await fetch(`${API_ROOT}/image/optimize-prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: params.prompt,
      size: params.size,
      style: params.style,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`提示词优化失败（${response.status}）：${errorText}`)
  }

  const payload = await response.json()
  const optimizedPrompt = payload.optimizedPrompt
  if (!optimizedPrompt) {
    throw new Error('未获取到优化后的提示词。')
  }

  return optimizedPrompt
}
