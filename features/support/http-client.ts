/**
 * Cliente HTTP de teste baseado em `fetch` contra uma URL base real. No nivel de
 * servico a URL e a do Nest em memoria (`app.listen(0)`); no ponta a ponta sera a
 * do servico no compose — por isso nao usamos `supertest`.
 */
export interface RespostaHttp<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class ClienteHttpTeste {
  constructor(private readonly baseUrl: string) {}

  get url(): string {
    return this.baseUrl;
  }

  async request<T = any>(metodo: string, caminho: string, opcoes: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<RespostaHttp<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...opcoes.headers };
    if (opcoes.token) headers.authorization = `Bearer ${opcoes.token}`;
    if (opcoes.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${caminho}`, {
      method: metodo,
      headers,
      body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
    });
    const texto = await res.text();
    let body: any = texto;
    try {
      body = texto ? JSON.parse(texto) : undefined;
    } catch {
      /* corpo nao-JSON fica como texto */
    }
    return { status: res.status, body, headers: res.headers };
  }

  get<T = any>(caminho: string, token?: string) {
    return this.request<T>('GET', caminho, { token });
  }
  post<T = any>(caminho: string, body?: unknown, token?: string, headers?: Record<string, string>) {
    return this.request<T>('POST', caminho, { body, token, headers });
  }
  delete<T = any>(caminho: string, token?: string) {
    return this.request<T>('DELETE', caminho, { token });
  }
}
