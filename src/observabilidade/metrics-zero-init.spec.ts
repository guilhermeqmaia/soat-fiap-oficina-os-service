import { inicializarSeriesDeNegocio, registry } from "./metrics.registry";

describe("inicializarSeriesDeNegocio", () => {
  it("expoe as series de negocio com 0 antes de qualquer evento", async () => {
    inicializarSeriesDeNegocio();
    const texto = await registry.metrics();
    expect(texto).toContain(
      'oficina_os_transicoes_total{de="RECEBIDA",para="EM_DIAGNOSTICO"} 0',
    );
    expect(texto).toContain(
      'oficina_integracoes_total{integracao="webhook-notificacao",resultado="falha"} 0',
    );
    expect(texto).toContain(
      'oficina_os_tempo_no_status_seconds_count{status="EM_EXECUCAO"} 0',
    );
    // cobranca depois da execucao (ADR-0012)
    expect(texto).toContain(
      'oficina_os_transicoes_total{de="EM_EXECUCAO",para="AGUARDANDO_PAGAMENTO"} 0',
    );
    expect(texto).toContain(
      'oficina_os_tempo_no_status_seconds_count{status="AGUARDANDO_PAGAMENTO"} 0',
    );
  });

  it("expoe as metricas do fluxo distribuido (US-F4-16) com 0: http_interno por rota e callbacks por type/resultado", async () => {
    inicializarSeriesDeNegocio();
    const texto = await registry.metrics();
    for (const resultado of ["sucesso", "recusa", "esgotado", "erro"]) {
      expect(texto).toContain(
        `oficina_http_interno_total{origem="os-service",destino="billing-service",rota="POST /orcamentos/{numero}/cobrar",resultado="${resultado}"} 0`,
      );
    }
    expect(texto).toContain(
      'oficina_http_interno_total{origem="os-service",destino="execucao-service",rota="POST /execucao/ordens",resultado="esgotado"} 0',
    );
    for (const resultado of ["aplicado", "duplicado", "ignorado", "conflito", "nao_encontrado", "erro"]) {
      expect(texto).toContain(
        `oficina_callbacks_total{type="billing.pagamento-aprovado",resultado="${resultado}"} 0`,
      );
    }
    expect(texto).toContain('oficina_callbacks_total{type="outro",resultado="erro"} 0');
    // histograma declarado (HELP/TYPE) mesmo antes da primeira chamada
    expect(texto).toContain("# TYPE oficina_http_interno_duracao_seconds histogram");
    // a antiga continua sendo emitida (deprecated so para os participantes)
    expect(texto).toContain(
      'oficina_integracoes_total{integracao="billing-service",resultado="falha"} 0',
    );
  });

  it("tipoCallbackDaMetrica: so os types do contrato viram label; o resto e 'outro'", async () => {
    const { tipoCallbackDaMetrica, TIPOS_CALLBACK } = await import("./metrics.registry");
    for (const t of TIPOS_CALLBACK) expect(tipoCallbackDaMetrica(t)).toBe(t);
    expect(tipoCallbackDaMetrica("execucao.enfileirada")).toBe("outro");
  });

  it("e idempotente (nao zera contagens ja registradas)", async () => {
    const { osTransicoes } = await import("./metrics.registry");
    osTransicoes.inc({ de: "RECEBIDA", para: "EM_DIAGNOSTICO" });
    inicializarSeriesDeNegocio();
    expect(await registry.metrics()).toContain(
      'oficina_os_transicoes_total{de="RECEBIDA",para="EM_DIAGNOSTICO"} 1',
    );
  });
});

describe("OsMetricsListener — tempo no status", () => {
  it("observa a duracao no status anterior quando o evento traz a entrada", async () => {
    const { OsMetricsListener } =
      await import("./application/os-metrics.listener");
    const { OsStatusAlteradoEvent } =
      await import("../ordem-de-servico/domain/events/os-status-alterado.event");
    const { StatusOS } =
      await import("../ordem-de-servico/domain/value-objects/status-os.vo");
    const listener = new OsMetricsListener();
    const entrada = new Date(Date.now() - 120_000);
    listener.onStatusAlterado(
      new OsStatusAlteradoEvent(
        "os-1",
        "OS-1",
        "cli-1",
        StatusOS.RECEBIDA,
        StatusOS.EM_DIAGNOSTICO,
        new Date(),
        entrada,
      ),
    );
    const texto = await registry.metrics();
    expect(texto).toMatch(
      /oficina_os_tempo_no_status_seconds_count\{status="RECEBIDA"\} 1/,
    );
    expect(texto).toMatch(
      /oficina_os_tempo_no_status_seconds_sum\{status="RECEBIDA"\} 1(19|20)/,
    );
  });
});
