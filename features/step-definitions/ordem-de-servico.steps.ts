import { DataTable, Given, Then, When } from '@cucumber/cucumber';
import { expect } from 'expect';
import { aguardarAte } from '../support/polling';
import type { MundoOS, ServicoCallback } from '../support/world';

/**
 * Steps genericos da OrdemDeServico e da saga, na linguagem do dominio. Escritos
 * para serem copiados pelos fluxos 1 e 2 (ver docs/bdd/README.md).
 */
function servicoCallback(nome: string): ServicoCallback {
  if (nome !== 'Execução' && nome !== 'Billing') throw new Error(`Servico desconhecido "${nome}". Use "Execução" ou "Billing".`);
  return nome;
}

/** "" ou "-" = lista vazia; senao, itens separados por virgula. */
function lista(texto: string): string[] {
  const t = texto.trim();
  return t === '' || t === '-' ? [] : t.split(',').map((s) => s.trim());
}

// ---------------- Dado ----------------

Given('que existe um cliente com veículo', async function (this: MundoOS) {
  await this.criarClienteComVeiculo();
});

Given('que existe uma OS no status {string}', async function (this: MundoOS, status: string) {
  await this.levarAteStatus(status);
});

// ---------------- Quando ----------------

When('o atendente abre uma OS para o veículo', async function (this: MundoOS) {
  await this.abrirOS();
});

When('o serviço {string} envia o callback {string} para a OS', async function (this: MundoOS, servico: string, type: string) {
  await this.enviarCallback(servicoCallback(servico), type);
});

When('o serviço {string} envia o callback {string} para a OS com:', async function (this: MundoOS, servico: string, type: string, dados: DataTable) {
  await this.enviarCallback(servicoCallback(servico), type, dados.rowsHash());
});

When('o serviço {string} reenvia o mesmo callback', async function (this: MundoOS, servico: string) {
  expect(this.ultimoCallback?.servico).toBe(servicoCallback(servico));
  await this.reenviarUltimoCallback();
});

When('o atendente cancela a OS', async function (this: MundoOS) {
  await this.cancelarOS('atendente');
});

When('o atendente entrega o veículo', async function (this: MundoOS) {
  await this.entregarVeiculo();
});

When('o administrador reprocessa a saga', async function (this: MundoOS) {
  await this.reprocessarSaga();
  expect(this.ultimaResposta!.status).toBe(200);
});

// ---------------- Então: OS ----------------

Then('a OS fica com status {string}', async function (this: MundoOS, status: string) {
  await this.aguardarStatus(status);
});

Then('a OS permanece com status {string}', async function (this: MundoOS, status: string) {
  expect((await this.statusDaOS()).status).toBe(status);
});

Then('a OS é cancelada com o motivo {string}', async function (this: MundoOS, motivo: string) {
  await aguardarAte(`OS ${this.ordem.numero} CANCELADA (${motivo})`, () => this.statusDaOS(), (s) => {
    expect(s).toMatchObject({ status: 'CANCELADA', motivoCancelamento: motivo });
  });
});

Then('a resposta tem status HTTP {int}', function (this: MundoOS, status: number) {
  expect(this.ultimaResposta?.status).toBe(status);
});

// ---------------- Então: saga ----------------

Then('a saga fica no passo {string} com status {string}', async function (this: MundoOS, passo: string, status: string) {
  await aguardarAte(`saga da OS ${this.ordem.numero} em ${passo}/${status}`, () => this.sagaDaOS(), (s) => {
    expect({ passo: s.passo, status: s.status }).toEqual({ passo, status });
  });
});

Then('as compensações confirmadas da saga são {string}', async function (this: MundoOS, esperadas: string) {
  await aguardarAte(`compensacoes da saga da OS ${this.ordem.numero}`, () => this.sagaDaOS(), (s) => {
    expect(s.compensacoes.map((c) => [c.comando, !!c.confirmadaEm])).toEqual(lista(esperadas).map((c) => [c, true]));
  });
});

Then('a saga não tem compensações', async function (this: MundoOS) {
  expect((await this.sagaDaOS()).compensacoes).toEqual([]);
});

Then('o histórico da saga termina com {string} e resultado {string}', async function (this: MundoOS, evento: string, resultado: string) {
  const { historico } = await this.sagaDaOS();
  expect(historico[historico.length - 1]).toMatchObject({ evento, resultado });
});

// ---------------- Então: callback ----------------

Then('o callback é aplicado', function (this: MundoOS) {
  expect(this.ultimaResposta?.status).toBe(200);
  expect(this.ultimaResposta?.body).toMatchObject({ aplicado: true });
});

Then('o callback é reconhecido como duplicado e não é reaplicado', function (this: MundoOS) {
  expect(this.ultimaResposta?.status).toBe(200);
  expect(this.ultimaResposta?.body).toMatchObject({ aplicado: false, duplicado: true });
});

// ---------------- Então: notificacao ----------------
// US-F4-12: um tipo por marco da OS — ORCAMENTO_PRONTO, ORCAMENTO_APROVADO,
// PAGAMENTO_PENDENTE (com link), PAGAMENTO_APROVADO, PAGAMENTO_RECUSADO,
// OS_FINALIZADA, OS_CANCELADA — alem do generico STATUS_OS_ALTERADO.

Then('o cliente recebe a notificação {string}', async function (this: MundoOS, tipo: string) {
  await aguardarAte(`notificacao ${tipo} da OS ${this.ordem.numero}`, () => this.notificacoesDaOS(), (ns) => {
    expect(ns.map((n) => n.tipo)).toContain(tipo);
  });
  const n = (await this.notificacoesDaOS()).find((x) => x.tipo === tipo)!;
  expect(n.destinatario).toBe(this.cliente!.email);
  expect(n.assunto).toContain(this.ordem.numero);
  expect(n.numeroOS).toBe(this.ordem.numero);
  expect(n.eventoId).toBeTruthy();
});

Then('o cliente recebe a notificação {string} com o link de pagamento', async function (this: MundoOS, tipo: string) {
  const ns = await aguardarAte(`notificacao ${tipo} com link da OS ${this.ordem.numero}`, () => this.notificacoesDaOS(), (lista) => {
    expect(lista.filter((n) => n.tipo === tipo && n.linkPagamento).length).toBeGreaterThan(0);
  });
  // o link e o devolvido no 201 de POST /orcamentos/{n}/cobrar (stub do Billing)
  const n = ns.filter((x) => x.tipo === tipo && x.linkPagamento)[0];
  expect(n.linkPagamento).toMatch(/^https:\/\/mp\.test\/pay\/mp-\d+$/);
  expect(n.mensagem).toContain(n.linkPagamento!);
});

Then('o cliente recebe a notificação {string} mencionando {string}', async function (this: MundoOS, tipo: string, trecho: string) {
  await aguardarAte(`notificacao ${tipo} com "${trecho}" da OS ${this.ordem.numero}`, () => this.notificacoesDaOS(), (ns) => {
    expect(ns.filter((n) => n.tipo === tipo).map((n) => n.mensagem).join(' | ')).toContain(trecho);
  });
});

Then('o cliente recebe {int} notificação/notificações {string}', async function (this: MundoOS, quantidade: number, tipo: string) {
  // espera chegar ao menos `quantidade` e confere que nao passou disso
  const ns = await aguardarAte(`${quantidade}x ${tipo} da OS ${this.ordem.numero}`, () => this.notificacoesDaOS(), (lista) => {
    expect(lista.filter((n) => n.tipo === tipo).length).toBeGreaterThanOrEqual(quantidade);
  });
  expect(ns.filter((n) => n.tipo === tipo)).toHaveLength(quantidade);
});

Then('o cliente não recebe a notificação {string}', async function (this: MundoOS, tipo: string) {
  expect((await this.notificacoesDaOS()).map((n) => n.tipo)).not.toContain(tipo);
});

Then('o cliente não recebe a notificação {string} para o status {string}', async function (this: MundoOS, tipo: string, status: string) {
  // a generica so e suprimida nos status com notificacao propria (US-F4-12)
  const ns = await this.notificacoesDaOS();
  expect(ns.filter((n) => n.tipo === tipo && n.eventoId?.endsWith(`:${status}`))).toEqual([]);
});
