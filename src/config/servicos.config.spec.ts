import { httpInternoConfig, urlsDosParticipantes } from './servicos.config';

describe('urlsDosParticipantes', () => {
  it('sem variaveis usa localhost nas portas convencionadas', () =>
    expect(urlsDosParticipantes({})).toEqual({ execucao: 'http://localhost:3002', billing: 'http://localhost:3001' }));
  it('respeita as variaveis e remove a barra final', () =>
    expect(urlsDosParticipantes({ EXECUCAO_SERVICE_URL: 'http://execucao-service:3002/', BILLING_SERVICE_URL: 'http://billing-service:3001' })).toEqual({
      execucao: 'http://execucao-service:3002',
      billing: 'http://billing-service:3001',
    }));
});

describe('httpInternoConfig', () => {
  it('sem variaveis deixa os defaults do kit', () => expect(httpInternoConfig({})).toEqual({ timeoutMs: undefined, tentativas: undefined }));
  it('le timeout e tentativas; ignora valores invalidos', () => {
    expect(httpInternoConfig({ HTTP_INTERNO_TIMEOUT_MS: '2000', HTTP_INTERNO_TENTATIVAS: '2' })).toEqual({ timeoutMs: 2000, tentativas: 2 });
    expect(httpInternoConfig({ HTTP_INTERNO_TIMEOUT_MS: 'x', HTTP_INTERNO_TENTATIVAS: '0' })).toEqual({ timeoutMs: undefined, tentativas: undefined });
  });
});
