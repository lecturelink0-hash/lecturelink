type ApiPayload<T> = {
  ok?: boolean;
  data?: T;
  error?: { message?: string };
};

export async function readApiResponse<T>(
  response: Response,
  fallbackMessage: string,
): Promise<ApiPayload<T>> {
  const body = await response.text();

  if (!body.trim()) {
    throw new Error(
      response.status === 413
        ? "생성된 결과가 너무 커서 전송하지 못했습니다. 다시 시도해주세요."
        : fallbackMessage,
    );
  }

  try {
    return JSON.parse(body) as ApiPayload<T>;
  } catch {
    if (response.status === 413 || /request entity too large/i.test(body)) {
      throw new Error(
        "생성된 결과가 너무 커서 전송하지 못했습니다. 잠시 후 다시 생성해주세요.",
      );
    }

    throw new Error(
      response.ok
        ? "서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해주세요."
        : `${fallbackMessage} (오류 코드 ${response.status})`,
    );
  }
}
