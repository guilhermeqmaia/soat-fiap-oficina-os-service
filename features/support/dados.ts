import { randomInt } from 'node:crypto';

/** CPF valido (digitos verificadores corretos) e aleatorio: cada cenario tem o seu cliente. */
export function cpfAleatorio(): string {
  const base = Array.from({ length: 9 }, () => randomInt(10));
  if (base.every((d) => d === base[0])) base[0] = (base[0] + 1) % 10;
  const dv = (nums: number[]) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

/** Placa Mercosul aleatoria (AAA9A99). */
export function placaAleatoria(): string {
  const letra = () => String.fromCharCode(65 + randomInt(26));
  return `${letra()}${letra()}${letra()}${randomInt(10)}${letra()}${randomInt(10)}${randomInt(10)}`;
}

/** Itens do diagnostico usados por padrao (1 servico + 1 produto = R$ 300,00). */
export const ITENS_DIAGNOSTICO = [
  { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' },
  { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
];
