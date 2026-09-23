# Publicação de versões por página

## Uso

1. Em `/paginas`, ative **Publicar em várias páginas**, marque os destinos da conta e salve.
2. Opcionalmente, em `/minha-marca`, abra **Marca por página** para escolher modelo, cores, nome, categoria, rodapé e logo. Fonte, tamanho e ajustes do modelo são copiados da marca da conta ao salvar. Sem marca própria, usa-se a configuração da conta.
3. No editor `/materias-ia/:id`, clique em **Preparar versões**. Os rascunhos têm título, texto e arte próprios e aparecem em Matérias salvas. O conteúdo usa somente a matéria principal; Claude confere fidelidade antes de liberar o preparo.
4. Revise os destinos e clique em **Publicar nas páginas**. O envio é para Facebook, em uma ação, processado pela fila existente. Instagram/X e agendamentos continuam nos fluxos individuais.

A principal é preservada. As versões têm links para ela, não geram novos grupos e cada destino possui um registro único. Em Reels, o arquivo de vídeo é copiado sem alterar sua montagem/capa incorporada; título e legenda variam. A marca por página gera a arte da matéria, não reedita o vídeo.

## Operação

- Aplicar `npm run migrate` antes de usar o recurso e reiniciar o processo da aplicação. A migração adiciona três tabelas e `ai_matters.distribution_brand`, sem ativar envios para usuários existentes.
- Preparar, salvar, abrir telas e habilitar a configuração não enviam publicações.
- Cliques repetidos usam transições atômicas no banco; destinos enviados não são reenviados pelo grupo.
- Erro/timeout de publicação fica como **Conferir envio na página**. Não há repetição automática, pois o provedor pode ter recebido o post mesmo sem devolver resposta.
- A fila atual é em memória. Após interrupção do processo, trabalhos sem atualização por 30 minutos deixam de aparecer indefinidamente em processamento: preparo pode ser solicitado novamente; envio exige conferência.
- Desativar a seleção antes da execução impede novos envios da fila. Um pedido já recebido pelo provedor não pode ser desfeito por essa configuração.

## Validação

`node --test tests/pageDistribution.test.js tests/publishDispatchXIsolation.test.js`

Os testes simulam IA/publicação e cobrem isolamento de contas, concorrência, alterações da principal, marca própria e falhas parciais sem reenvio. Não publicam em redes sociais.
