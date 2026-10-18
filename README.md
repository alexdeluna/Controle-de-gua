# Controle de Água Residencial — Protótipo local

## Como executar
1. Extraia a pasta do ZIP.
2. Abra a pasta no VS Code.
3. Execute por um servidor local, como a extensão Live Server.
4. Abra `index.html` pelo endereço local do servidor.

O Service Worker e a instalação como PWA exigem localhost ou HTTPS. Abrir o HTML diretamente pelo caminho `file://` não ativa esses recursos.

## Recursos nesta versão
- Painel com volume estimado, capacidade e alerta.
- Registro de abastecimento com data e hora obrigatórias.
- Registro de transferência para a caixa com data e hora obrigatórias; cada transferência reduz o saldo estimado da cisterna.
- Medição manual do volume da cisterna.
- Histórico em cards.
- Relatório mensal, exportação CSV e backup/restauração JSON.
- Persistência local por localStorage.

## Limitações conhecidas do protótipo
- Dados ficam apenas neste navegador/dispositivo; não há compartilhamento entre celulares ainda.
- Não há login ou Firebase nesta etapa.
- A autonomia só aparece quando existem medições suficientes para calcular consumo.
- O consumo inferido a partir das medições não deve ser interpretado como consumo doméstico exato; a transferência para a caixa é registrada separadamente.
- Usuário responsável aparece como “Usuário local” até a integração de contas individuais.

## Testes manuais recomendados
1. Registre uma medição inicial de 2.800 L.
2. Registre abastecimento de 1.000 L por R$ 50,00 e confira que o volume estimado aumenta para 3.800 L.
3. Registre transferência de 500 L para a caixa e confira que o volume estimado diminui para 3.300 L.
4. Registre outra medição depois de alguns dias e confira se o consumo médio é calculado.
5. Confira o alerta ao informar volume igual ou inferior a 1.000 L.
6. Feche e reabra o app e confirme a persistência dos dados.
7. Exporte CSV e backup JSON e teste restaurar o backup.

## Regra importante sobre a caixa-d'água
A caixa é tratada como recipiente de destino, normalmente completado a cada transferência. O protótipo não mantém saldo estimado da caixa; após transferir, exibe um lembrete para conferir o nível real. O volume transferido é descontado da cisterna.


## Firebase: autenticação e base compartilhada

Esta versão usa o projeto Firebase informado, Firebase Authentication por e-mail/senha e Cloud Firestore. O ID compartilhado da residência está definido como `casa-principal`.

### 1. Ativar o login por e-mail e senha
No Console do Firebase, abra **Authentication → Sign-in method** e habilite **E-mail/senha**.

### 2. Criar o Firestore e publicar as regras
1. Abra **Firestore Database** e crie o banco de dados.
2. Abra a aba **Rules**.
3. Copie o conteúdo do arquivo `firestore.rules` e publique.
4. Não use regras abertas de teste ou regras que permitam acesso a qualquer usuário autenticado.

### 3. Criar as contas
Crie a sua conta e a conta da sua esposa na tela de login do aplicativo. A criação da conta autentica o usuário, mas não dá acesso automático aos dados da residência.

### 4. Vincular as duas contas à residência
Para cada conta, abra **Authentication → Users** e copie o UID. Depois, no Firestore, crie os documentos abaixo manualmente (o Console do Firebase permite a configuração inicial sem passar pelas regras do cliente):

- Caminho: `residencias/casa-principal/membros/UID_DO_USUARIO`
- Campos:
  - `ativo` (boolean): `true`
  - `nome` (string): nome da pessoa
  - `papel` (string): `responsavel` ou `membro`

Faça isso para os dois UIDs. Não coloque senha ou outros segredos nesses documentos. As regras impedem que um usuário se adicione a si próprio por meio do aplicativo.

### 5. Primeiro acesso
Depois de vinculada, cada conta poderá entrar e acessar os mesmos abastecimentos, transferências, medições, configurações e histórico. Os lançamentos incluem o nome/e-mail da conta que os registrou.

### Estrutura Firestore
- `residencias/casa-principal/configuracao/principal`
- `residencias/casa-principal/abastecimentos/{id}`
- `residencias/casa-principal/transferencias/{id}`
- `residencias/casa-principal/medicoes/{id}`
- `residencias/casa-principal/auditoria/{id}`
- `residencias/casa-principal/membros/{uid}`

### Observações de segurança e sincronização
- A configuração web do Firebase, incluindo `apiKey`, identifica o projeto; não substitui as regras de segurança. A proteção dos dados é feita pelas regras do Firestore e pela associação do UID à residência.
- Os membros ativos podem ler, criar, atualizar e excluir os documentos de histórico nas quatro coleções de registros.
- Ao conectar, o Firestore é a fonte oficial: os arrays locais antigos não são mesclados nem enviados automaticamente. Isso impede que registros de teste reapareçam depois de apagados no servidor.
- Em Configurações → Dados e backup existem duas ações distintas: “Limpar dados deste dispositivo” não exclui dados compartilhados; “Excluir dados compartilhados do Firebase” apaga os registros das coleções abastecimentos, transferencias, medicoes e auditoria e restaura as configurações padrão. As contas de membros são preservadas.
- Após instalar esta versão, publique as novas regras de `firestore.rules` no Console do Firebase; sem isso, a exclusão compartilhada será negada pelas regras antigas.
- A exclusão compartilhada requer conexão e confirmação digitando `EXCLUIR`. Não pode ser desfeita. Faça backup antes de usá-la.
- O ID `casa-principal` é fixo nesta versão. Para outra residência, seria necessário alterar o ID no arquivo `js/firebase.js` e ajustar o caminho dos membros.


## Correção de gravação no Firebase — versão 8
- Abastecimentos, transferências e medições são enviados individualmente ao Firestore com `await setDoc`.
- A mensagem de sucesso só aparece depois que o Firestore confirma a gravação; em caso de falha, a tela mostra o erro.
- Removida a sincronização automática do estado local inteiro a cada alteração, que poderia ser sobrescrita por um snapshot remoto antes de terminar a gravação.
- O cache do Service Worker foi atualizado para `controle-agua-v8`.
- Esta versão não importa automaticamente registros antigos do `localStorage` para o Firestore.
- Publicar as regras do arquivo `firestore.rules` no Console do Firebase e substituir os arquivos da hospedagem antes de testar.
