// Renderer 发送链路的纯逻辑：便于在不启动 Electron 的情况下验证目标选择和 IPC 解包。
export function selectedSessionId(subViewId: string | null, currentMainId: string): string {
  return subViewId ?? currentMainId;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  needsProvider?: boolean;
}

export function unwrapSendResult(response: any): SendResult {
  const result = response?.data ?? response;
  if (result?.ok) return { ok: true };
  return {
    ok: false,
    error: result?.error ?? response?.error ?? '发送失败',
    needsProvider: !!result?.needsProvider,
  };
}
