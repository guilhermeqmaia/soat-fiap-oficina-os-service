import { DataTable, Given, Then, When } from '@cucumber/cucumber';
import { expect } from 'expect';
import { mailpit, labels, pagar, participantes, valorMetrica } from '../../support/e2e/ambiente';
import { aguardarAte } from '../../support/polling';
import { tokenDe } from '../../support/tokens';
import type { MundoOS } from '../../support/world';

/**
 * Steps SO do ponta a ponta (perfil e2e). As acoes de pessoa acontecem no
 * participante (Execucao/Billing do compose), que envia o callback ao OS — por
 * baixo, `MundoOS.enviarCallback` delega ao `acionadorE2e`. Os "Então" de OS,
 * saga, notificacao e chamadas sao os mesmos do nivel de servico.
 */
function participante(nome: string) {
  if (nome !== 'Execução' && nome !== 'Billing') throw new Error(`Servico desconhecido "${nome}". Use "Execução" ou "Billing".`);
  return participantes[nome];
}

// ---------------------------------------------------------------- acoes das pessoas

When('o mecânico conclui o diagnóstico na Execução', async function (this: MundoOS) {
  await this.enviarCallback('Execução', 'execucao.diagnostico-concluido');
});

When('o mecânico finaliza a execução', async function (this: MundoOS) {
  await this.enviarCallback('Execução', 'execucao.finalizada');
});

When('o cliente aprova o orçamento no Billing', async function (this: MundoOS) {
  await this.enviarCallback('Billing', 'billing.orcamento-aprovado');
});

When('o cliente rejeita o orçamento no Billing', async function (this: MundoOS) {
  await this.enviarCallback('Billing', 'billing.orcamento-rejeitado');
});

When('o cliente paga a cobrança', async function (this: MundoOS) {
  await pagar(this);
});

// ---------------------------------------------------------------- cenario dos stubs

Given('que o Mercado Pago vai recusar o próximo pagamento', async function () {
  await participantes.Billing.cenario({ pagamento: 'recusado', motivoRecusaPagamento: 'cartao recusado' });
});

Given('que o serviço {string} responde 5xx nas próximas {int} chamadas em {string}', async function (servico: string, quantidade: number, rota: string) {
  await participante(servico).falharProximas(quantidade, rota);
});

When('o OS Service pede de novo à Execução para enfileirar a OS', async function (this: MundoOS) {
  // mesma requisicao que o orquestrador faz (JWT de servico, x-correlation-id)
  this.ultimaResposta = await participantes.Execução.http.post(
    '/execucao/ordens',
    { numeroOS: this.ordem.numero, veiculoId: this.veiculo!.id, descricaoProblema: 'Cliente relata barulho ao frear' },
    tokenDe('os'),
    { 'x-correlation-id': this.ordem.numero },
  );
});

// ---------------------------------------------------------------- estado nos participantes

Then('o serviço {string} registra a OS com status {string}', async function (this: MundoOS, servico: string, status: string) {
  await aguardarAte(`${servico} com a OS ${this.ordem.numero} em ${status}`, () => participante(servico).estado(this.ordem.numero), (e) => {
    expect(e?.status).toBe(status);
  });
});

Then('a Execução devolve a mesma posição na fila, sem duplicar a ordem', async function (this: MundoOS) {
  const estado = await participantes.Execução.estado(this.ordem.numero);
  expect(this.ultimaResposta?.status).toBe(201);
  expect(this.ultimaResposta?.body).toEqual({ numeroOS: this.ordem.numero, posicaoFila: estado!.posicaoFila });
  expect(estado!.historico.filter((h: { evento: string }) => h.evento === 'enfileirada')).toHaveLength(1);
});

Then('o Billing emitiu {int} cobrança(s) com links diferentes', async function (this: MundoOS, quantidade: number) {
  const estado = await participantes.Billing.estado(this.ordem.numero);
  const links = (estado!.cobrancas as Array<{ linkPagamento: string }>).map((c) => c.linkPagamento);
  expect(new Set(links).size).toBe(quantidade);
});

// ---------------------------------------------------------------- saga

// No historico, `evento` e o comando e `resultado` e "chamada-falhou" (retry esgotado, US-F4-18).
Then('o histórico da saga registra o comando {string} não entregue após {int} tentativas', async function (this: MundoOS, comando: string, tentativas: number) {
  await aguardarAte(`historico da saga com ${comando} chamada-falhou`, () => this.sagaDaOS(), (s) => {
    const e = s.historico.find((h) => h.evento === comando && h.resultado === 'chamada-falhou') as (typeof s.historico)[number] & { tentativas?: number };
    expect(e).toBeDefined();
    expect(e.tentativas ?? Number(/(\d+) tentativa/.exec(e.detalhe ?? '')?.[1])).toBe(tentativas);
  });
});

// ---------------------------------------------------------------- notificacoes

Then('o histórico de notificações da OS lista {string}', async function (this: MundoOS, tipos: string) {
  const esperados = tipos.split(',').map((t) => t.trim());
  await aguardarAte(`GET /notificacoes da OS ${this.ordem.numero}`, () => this.http.get(`/notificacoes?ordemDeServicoId=${this.ordem.id}&limit=100`, tokenDe('atendente')), (r) => {
    expect(r.status).toBe(200);
    const recebidos = r.body.data.map((n: { tipo: string }) => n.tipo);
    expect(recebidos).toEqual(expect.arrayContaining(esperados));
    for (const n of r.body.data) expect(n).toMatchObject({ canal: 'EMAIL', destinatario: this.cliente!.email });
  });
});

interface MensagemMailpit {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function emailsDoCliente(mundo: MundoOS, trecho: string): Promise<MensagemMailpit[]> {
  const query = encodeURIComponent(`to:"${mundo.cliente!.email}"`);
  const r = await mailpit.get(`/api/v1/search?query=${query}&limit=200`);
  expect(r.status).toBe(200);
  return (r.body.messages as MensagemMailpit[]).filter((m) => m.Subject.includes(mundo.ordem.numero) && m.Subject.includes(trecho));
}

Then('o cliente recebe o e-mail {string} no Mailpit', async function (this: MundoOS, trecho: string) {
  await aguardarAte(`e-mail "${trecho}" da OS ${this.ordem.numero} no Mailpit`, () => emailsDoCliente(this, trecho), (ms) => {
    expect(ms.length).toBeGreaterThan(0);
  });
});

Then('o cliente recebe {int} e-mail(s) {string} no Mailpit', async function (this: MundoOS, quantidade: number, trecho: string) {
  const ms = await aguardarAte(`${quantidade} e-mail(s) "${trecho}" no Mailpit`, () => emailsDoCliente(this, trecho), (lista) => {
    expect(lista.length).toBeGreaterThanOrEqual(quantidade);
  });
  expect(ms).toHaveLength(quantidade);
});

Then('o e-mail {string} no Mailpit traz o link de pagamento do Billing', async function (this: MundoOS, trecho: string) {
  const [msg] = await aguardarAte(`e-mail "${trecho}" no Mailpit`, () => emailsDoCliente(this, trecho), (ms) => {
    expect(ms.length).toBeGreaterThan(0);
  });
  const corpo = await mailpit.get(`/api/v1/message/${msg.ID}`);
  const estado = await participantes.Billing.estado(this.ordem.numero);
  const link = estado!.cobrancas[estado!.cobrancas.length - 1].linkPagamento as string;
  expect(String(corpo.body.Text)).toContain(link);
});

// ---------------------------------------------------------------- metricas

Then('as métricas do OS Service aumentaram:', async function (this: MundoOS, tabela: DataTable) {
  const linhas = tabela.hashes() as Array<{ métrica: string; labels: string; aumento: string }>;
  await aguardarAte('aumento das metricas em GET /metrics', () => this.http.get('/metrics'), (r) => {
    const agora = String(r.body);
    const real = linhas.map((l) => ({ ...l, aumento: String(valorMetrica(agora, l.métrica, labels(l.labels)) - valorMetrica(this.metricasAntes!, l.métrica, labels(l.labels))) }));
    expect(real).toEqual(linhas);
  });
});
