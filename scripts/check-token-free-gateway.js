require('dotenv').config();

const gateway = require('../src/services/tokenFreeGatewayService');

async function main() {
  const saude = await gateway.verificarSaude();
  const modelos = await gateway.listarModelos();
  const ids = modelos.map((modelo) => String(modelo?.id || '')).filter(Boolean);
  const modeloConfigurado = ids.includes(gateway.MODELO);

  console.log(`Gateway: ${gateway.BASE_URL}`);
  console.log(`Saude: ${saude?.status || 'desconhecida'}`);
  console.log(`Chrome: ${saude?.browser || 'desconhecido'}`);
  console.log(`Provedores autorizados: ${saude?.providers ?? '?'}`);
  console.log(`Modelo configurado: ${gateway.MODELO} (${modeloConfigurado ? 'disponivel' : 'NAO encontrado'})`);
  console.log(`Modelos Claude: ${ids.filter((id) => id.startsWith('claude-')).join(', ') || 'nenhum'}`);

  if (saude?.status !== 'ok' || !modeloConfigurado) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
