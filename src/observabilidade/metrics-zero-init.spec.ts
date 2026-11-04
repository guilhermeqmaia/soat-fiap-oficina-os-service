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
