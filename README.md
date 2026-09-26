# estalecas 🪙

Simulador de apostas em futebol **apenas demonstrativo**. A moeda é fictícia — **estalecas** — e não tem nenhum valor real. Não existe depósito, saque ou prêmio.

Os **jogos, horários, placares ao vivo e resultados são reais**, puxados direto da API pública da ESPN pelo navegador de quem acessa o site (não precisa de chave nem servidor).

## O que tem

- Jogos de 15 campeonatos: Brasileirão A e B, Copa do Brasil, Libertadores, Sul-Americana, Champions, Europa League, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Liga Portugal, MLS e Argentina
- Navegação por dia (3 dias para trás, 7 para frente) e filtros: ao vivo, próximos, encerrados, por campeonato
- Placar e minuto ao vivo, atualizando sozinho a cada 30 s quando há jogo rolando
- Mercados: resultado final (1X2), mais/menos de 2,5 gols e ambas marcam
- Cupom com aposta **simples** ou **múltipla**
- Carteira começa com **1.000 estalecas**, com bônus diário de +100
- **Liquidação automática**: quando o jogo termina, a aposta é marcada como ganha/perdida e o prêmio cai no saldo. Jogo adiado ou cancelado devolve o valor
- Histórico com apostado, ganhos e lucro
- Funciona no celular (cupom em “gaveta” na parte de baixo)

Carteira e apostas ficam salvas no próprio navegador (localStorage) — cada pessoa tem a sua.

## Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (ex.: `estalecas`), público.
2. Envie **o conteúdo desta pasta** para a raiz do repositório (`index.html` precisa ficar na raiz):
   - pelo site: *Add file → Upload files* e arraste tudo (incluindo as pastas `css`, `js` e `assets`);
   - ou pelo terminal:
     ```bash
     git init
     git add .
     git commit -m "estalecas"
     git branch -M main
     git remote add origin https://github.com/SEU-USUARIO/estalecas.git
     git push -u origin main
     ```
3. No repositório: *Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save*.
4. Em 1–2 minutos o site fica no ar em `https://SEU-USUARIO.github.io/estalecas/`.

Para testar localmente, basta abrir o `index.html` no navegador (ou rodar `python3 -m http.server` na pasta e acessar `http://localhost:8000`).

## Como funcionam as cotações

A ESPN fornece jogos e placares, mas raramente cotações de futebol. Quando existe cotação de mercado no retorno da API, o site usa ela (aparece “cotação de mercado” no card). Caso contrário, o próprio site calcula uma cotação com um modelo simples: aproveitamento de pontos de cada time na competição + vantagem de mando + 6% de margem da “casa”. É uma estimativa para a brincadeira, não uma previsão séria.

A cotação fica travada no momento da aposta. Só dá para apostar em jogos que ainda não começaram.

## Limitações

- O resultado considerado é o placar final informado pela ESPN (em mata-mata, inclui prorrogação; pênaltis não contam).
- Se a ESPN mudar ou bloquear a API, os jogos param de carregar — o site mostra um aviso com botão de tentar de novo.
- Os campeonatos ficam na lista `LEAGUES`, no início de `js/app.js`. Dá para incluir outros usando o código da liga na ESPN (ex.: `bra.3`, `ned.1`, `mex.1`).

## Estrutura

```
index.html
css/style.css
js/app.js
assets/coin.svg
```

---

Projeto educacional. Apostas reais envolvem risco financeiro e são proibidas para menores de 18 anos.
