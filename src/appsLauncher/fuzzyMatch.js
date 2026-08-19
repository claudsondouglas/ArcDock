// Casamento difuso (subsequência com bônus posicionais) usado pela busca do
// launcher. Este módulo é PURO de propósito: não importa `gi://` nada, só
// String/Int32Array. Isso permite (a) rodar a pontuação fora do gnome-shell
// para conferir o ranking e (b) deixar claro que nada aqui toca actor, GLib
// ou Shell — o acoplamento com o Shell mora inteiro em appList.js.

/**
 * Pesos da pontuação. Ficam aqui, e não em config.js, porque não são
 * "ajustes de gosto": a escala é normalizada contra o casamento PERFEITO
 * (ver `_idealScore`), então mexer em CHAR/HEAD/BOUNDARY/CONSECUTIVE muda o
 * denominador junto e só faz sentido lendo o algoritmo logo abaixo.
 */
export const SEARCH = Object.freeze({
    // --- Pontuação bruta, por caractere casado ---
    // Valor base de qualquer caractere que casa.
    CHAR: 16,
    // Primeiro caractere do nome. Maior que BOUNDARY porque "fire" em
    // "Firefox" tem que ganhar de "fire" em "GNOME Firewall Tool".
    HEAD: 22,
    // Caractere que abre uma palavra ("Studio" em "Visual Studio Code") ou
    // que vem colado no anterior. São IGUAIS de propósito: é isso que faz o
    // acrônimo "vsc" pontuar tão bem quanto o prefixo "vis", que é
    // exatamente o comportamento que se espera de um launcher.
    BOUNDARY: 14,
    CONSECUTIVE: 14,
    // Caractere que cai no MEIO de uma palavra depois de um salto. É o
    // casamento "por acaso" ("abc" achando a-b-c espalhados em três palavras
    // sem tocar em nenhuma inicial) e é o que o limiar precisa cortar.
    MID_WORD_PENALTY: 6,
    // Deslocamento do primeiro caractere: casar em "…x" no fim do nome vale
    // menos do que casar no começo. Linear e com teto, porque a diferença
    // entre "começa no 30" e "começa no 60" não interessa a ninguém.
    LEAD_PENALTY: 1,
    LEAD_PENALTY_MAX: 12,

    // --- Escala final ---
    // A pontuação bruta é dividida pelo casamento perfeito e multiplicada
    // por isto, então 1000 = "a query é exatamente o começo do nome".
    MAX_SCORE: 1000,
    // Desempate por comprimento: entre dois casamentos igualmente perfeitos
    // ("gimp" em "Gimp" e em "GNU Image Manipulation Program") o nome mais
    // curto vence. Leve e com teto — é desempate, não critério.
    LENGTH_PENALTY: 2,
    LENGTH_PENALTY_MAX: 40,

    // Limiar do casamento por NOME, medido nesta mesma escala de 1000. O
    // corte fica logo acima da faixa em que só o PRIMEIRO caractere acertou
    // algo relevante e o resto caiu no meio das palavras — que é exatamente
    // a definição de "essas letras aparecem nessa ordem em algum lugar".
    // Notas reais medidas sobre nomes de app de verdade:
    //   "fire" → Firefox                     994   prefixo
    //   "fire" → Firewall Configuration      964   duas iniciais de palavra
    //   "term" → GNOME Terminal              871   inicial de palavra
    //   "arq"  → Gerenciador de Arquivos     756   inicial de palavra
    //   "ffx"  → Firefox                     584   abreviação plausível
    //   ------------------------------------ 550   limiar
    //   "fire" → Fedora Media Writer         501   f + i,r,e soltos no meio
    // Abaixo do limiar o app ainda pode entrar por metadado, mas não mais
    // por semelhança de nome.
    MIN_NAME_SCORE: 550,

    // --- Metadados (nome genérico, descrição, keywords) ---
    // Metadado casa por SUBSTRING exata, nunca por subsequência difusa:
    // descrição é texto longo e corrido, onde qualquer subsequência de 3
    // letras existe. Pontuação fixa e abaixo de MIN_NAME_SCORE, então
    // qualquer casamento por nome vem antes de qualquer metadado.
    METADATA_SCORE: 300,
    METADATA_WORD_BONUS: 40,

    // --- Tolerância a erro de digitação ---
    // Último recurso: só roda quando a passada normal não achou NADA, e só
    // para query curta (numa query longa, sobra casamento parcial bom o
    // suficiente e o custo de N variantes por app deixaria de ser grátis).
    // Uma letra da query é descartada e o resto é casado normalmente — o que
    // cobre inserção, troca e (por tabela) transposição de um caractere.
    TYPO_MIN_QUERY: 3,
    TYPO_MAX_QUERY: 5,
    // A variante é julgada pelo MIN_NAME_SCORE normal (ela é uma query menor
    // e legítima, o rigor não muda), e só depois a nota é rebaixada a este
    // fator — assim um acerto com erro nunca compete de igual para igual com
    // um acerto exato, sem que o rebaixamento vire um segundo limiar
    // escondido.
    TYPO_FACTOR: 0.55,

    // Teto de caracteres do nome examinados pela matriz. Nome de app não
    // chega perto disso; o corte existe para que um .desktop patológico não
    // vire um laço de milhares de células a cada tecla.
    MAX_HAYSTACK: 128,
});

/** Ausência de casamento. Toda pontuação válida é >= 0. */
export const NO_MATCH = -1;

// Marcas combinantes do Unicode (U+0300–U+036F). Faixa conservadora de
// propósito: `\p{Diacritic}` também casa modificadores que NÃO são resíduo
// de NFD (ex: 'ʰ'), e removê-los mudaria o texto original em vez de só
// desacentuá-lo.
const COMBINING_MARKS = /[̀-ͯ]/g;

// Sentinela de "esta célula não casa". Não é -Infinity porque as matrizes
// são Int32Array (tipada para não realocar a cada tecla), e sobra folga de
// sobra contra qualquer soma de bônus.
const NEG = -1 << 29;

// Matrizes da programação dinâmica, reaproveitadas entre chamadas. Alocar
// duas linhas por app por tecla seria ~600 arrays por tecla digitada, tudo
// lixo imediato dentro do processo do compositor.
let _prevRow = new Int32Array(SEARCH.MAX_HAYSTACK);
let _currRow = new Int32Array(SEARCH.MAX_HAYSTACK);

/** Minúsculas + sem acentos, para comparar "Área" com "area". */
export function normalizeText(text) {
    if (typeof text !== 'string' || !text)
        return '';
    return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Sem acentos mas PRESERVANDO a caixa — é dela que sai o camelCase. */
function _deaccent(text) {
    if (typeof text !== 'string' || !text)
        return '';
    return text.normalize('NFD').replace(COMBINING_MARKS, '');
}

function _isUpper(code) {
    return code >= 65 && code <= 90;
}

function _isLower(code) {
    return code >= 97 && code <= 122;
}

function _isDigit(code) {
    return code >= 48 && code <= 57;
}

/** Separador = qualquer coisa que não seja letra ASCII nem dígito. */
function _isSeparator(code) {
    return !_isUpper(code) && !_isLower(code) && !_isDigit(code);
}

/**
 * Vetor de "aqui começa uma palavra", uma posição por caractere de `plain`.
 *
 * Uint8Array e não array de boolean: é lido dentro do laço mais quente do
 * módulo e é criado uma vez por app, no cache.
 *
 * @param {string} plain texto sem acento e COM a caixa original
 * @returns {Uint8Array}
 */
export function wordStartFlags(plain) {
    const flags = new Uint8Array(plain.length);
    if (!plain.length)
        return flags;
    flags[0] = 1;
    for (let i = 1; i < plain.length; i++) {
        const prev = plain.charCodeAt(i - 1);
        const curr = plain.charCodeAt(i);
        // Depois de separador ("GNU/Linux", "Node.js", "re_start").
        if (_isSeparator(prev))
            flags[i] = 1;
        // camelCase: "OpenShot" tem palavra em 'S'. Só minúscula→maiúscula;
        // maiúscula→maiúscula manteria "GNOME" como cinco palavras.
        else if (_isLower(prev) && _isUpper(curr))
            flags[i] = 1;
        // Primeiro dígito de um número ("Krita 5", "gtk3-widget").
        else if (_isDigit(curr) && !_isDigit(prev))
            flags[i] = 1;
    }
    return flags;
}

/**
 * Máscara de 28 bits com as classes de caractere presentes no texto: uma por
 * letra a–z, uma para dígitos e uma para "qualquer outra coisa".
 *
 * Serve de peneira antes da matriz: se a query usa uma letra que o campo não
 * tem, não existe subsequência possível e o app é descartado com um AND. A
 * imensa maioria dos apps morre aqui a cada tecla.
 */
export function charMask(text) {
    let mask = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 97 && code <= 122)
            mask |= 1 << (code - 97);
        else if (_isDigit(code))
            mask |= 1 << 26;
        else
            mask |= 1 << 27;
    }
    return mask;
}

/** Quantas classes de caractere da query faltam no campo (popcount). */
function _missingBits(queryMask, fieldMask) {
    let bits = queryMask & ~fieldMask;
    let count = 0;
    while (bits) {
        bits &= bits - 1;
        count++;
    }
    return count;
}

/**
 * Campos normalizados de um item pesquisável. Fica aqui, e não em
 * appList.js, para que a origem dos dados (Shell.App ou lista de teste) não
 * mude uma vírgula do que a pontuação enxerga.
 *
 * @param {string} rawName nome exibido, como veio do .desktop
 * @param {string} rawMetadata nome genérico + descrição + keywords, concatenados
 */
export function makeFields(rawName, rawMetadata) {
    const name = normalizeText(rawName);
    const plain = _deaccent(rawName);
    const metadata = normalizeText(rawMetadata);
    return {
        rawName,
        name,
        // toLowerCase() muda o comprimento em alguns casos exóticos (o 'İ'
        // turco vira 'i' + ponto). Se isso acontecer, os índices de `plain`
        // não valem para `name` e as flags saem do nome minúsculo mesmo —
        // perde-se o camelCase, nunca o alinhamento.
        starts: wordStartFlags(plain.length === name.length ? plain : name),
        mask: charMask(name),
        metadata,
        metadataMask: charMask(metadata),
    };
}

/** Pontuação bruta máxima possível para uma query de `n` caracteres. */
function _idealScore(n) {
    // Casamento perfeito = tudo colado a partir do caractere 0.
    return SEARCH.HEAD + n * SEARCH.CHAR + (n - 1) * SEARCH.BOUNDARY;
}

/**
 * Melhor pontuação bruta de `needle` como subsequência de `hay`, ou NEG.
 *
 * Programação dinâmica em duas linhas, no espírito do fzf: a célula (i, j)
 * guarda a melhor pontuação em que needle[i] casa exatamente em hay[j]. O
 * bônus mora no caractere que RECEBE o salto (início de palavra, colado no
 * anterior ou meio de palavra), e não no tamanho da lacuna — é isso que faz
 * "gimp" achar "GNU Image Manipulation Program" com nota cheia, apesar das
 * lacunas enormes, enquanto três letras caídas no meio de três palavras
 * quaisquer continuam valendo pouco.
 */
function _rawScore(needle, hay, starts) {
    const n = needle.length;
    const m = Math.min(hay.length, SEARCH.MAX_HAYSTACK);
    if (n === 0 || n > m)
        return NEG;

    if (_prevRow.length < m) {
        _prevRow = new Int32Array(m);
        _currRow = new Int32Array(m);
    }
    let prev = _prevRow;
    let curr = _currRow;

    for (let i = 0; i < n; i++) {
        const wanted = needle.charCodeAt(i);
        // needle[i] nunca casa antes da coluna i (faltariam colunas para os
        // i caracteres anteriores); o prefixo fica marcado como impossível.
        curr.fill(NEG, 0, i);
        // Melhor valor da linha anterior utilizável como origem de um salto
        // até a coluna j, isto é, max(prev[0..j-1]).
        let bestBefore = NEG;
        for (let j = i; j < m; j++) {
            if (i > 0 && prev[j - 1] > bestBefore)
                bestBefore = prev[j - 1];
            if (hay.charCodeAt(j) !== wanted) {
                curr[j] = NEG;
                continue;
            }
            if (i === 0) {
                const lead = Math.min(j * SEARCH.LEAD_PENALTY, SEARCH.LEAD_PENALTY_MAX);
                let bonus;
                if (j === 0)
                    bonus = SEARCH.HEAD;
                else if (starts[j])
                    bonus = SEARCH.BOUNDARY;
                else
                    bonus = -SEARCH.MID_WORD_PENALTY;
                curr[j] = SEARCH.CHAR + bonus - lead;
                continue;
            }
            // Vindo colado (prev[j-1]) o bônus é CONSECUTIVE; vindo de um
            // salto, só ganha bônus se aterrissar em início de palavra.
            const glued = prev[j - 1] > NEG
                ? prev[j - 1] + SEARCH.CHAR + (starts[j] ? SEARCH.BOUNDARY : SEARCH.CONSECUTIVE)
                : NEG;
            const jumped = bestBefore > NEG
                ? bestBefore + SEARCH.CHAR + (starts[j] ? SEARCH.BOUNDARY : -SEARCH.MID_WORD_PENALTY)
                : NEG;
            curr[j] = glued > jumped ? glued : jumped;
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }

    let best = NEG;
    for (let j = n - 1; j < m; j++) {
        if (prev[j] > best)
            best = prev[j];
    }
    return best;
}

/** Bruto → escala 0–1000, já com o desempate por comprimento do nome. */
function _finalScore(raw, needleLength, nameLength) {
    if (raw <= NEG)
        return NO_MATCH;
    const scaled = Math.round((raw / _idealScore(needleLength)) * SEARCH.MAX_SCORE);
    const extra = Math.max(0, nameLength - needleLength);
    const penalty = Math.min(extra * SEARCH.LENGTH_PENALTY, SEARCH.LENGTH_PENALTY_MAX);
    return Math.max(0, scaled - penalty);
}

/** Casamento por substring exata nos metadados, ou NO_MATCH. */
function _metadataScore(needle, fields, needleMask) {
    if (!fields.metadata)
        return NO_MATCH;
    if (needleMask & ~fields.metadataMask)
        return NO_MATCH;
    const at = fields.metadata.indexOf(needle);
    if (at < 0)
        return NO_MATCH;
    // Casar no começo de uma palavra da descrição ("editor de imagens" para
    // "edit") é bem mais informativo do que casar no meio de outra.
    const atWordStart = at === 0 || _isSeparator(fields.metadata.charCodeAt(at - 1));
    return SEARCH.METADATA_SCORE + (atWordStart ? SEARCH.METADATA_WORD_BONUS : 0);
}

/**
 * Pontuação de um item para `needle` (já normalizada), ou NO_MATCH.
 *
 * @param {string} needle
 * @param {number} needleMask máscara de `needle`, calculada uma vez pelo chamador
 * @param {object} fields resultado de makeFields()
 * @returns {number} 0–1000 (nome) ou ~300–340 (metadado), ou NO_MATCH
 */
export function scoreFields(needle, needleMask, fields) {
    // Peneira: sem todas as classes de caractere da query não há subsequência.
    if (!(needleMask & ~fields.mask)) {
        const raw = _rawScore(needle, fields.name, fields.starts);
        const score = _finalScore(raw, needle.length, fields.name.length);
        if (score >= SEARCH.MIN_NAME_SCORE)
            return score;
    }
    return _metadataScore(needle, fields, needleMask);
}

/**
 * Segunda passada, tolerante a UM erro de digitação. Só faz sentido chamar
 * quando `scoreFields` não achou nada em item nenhum — ver TYPO_* acima.
 *
 * Descarta uma letra da query por vez e pontua a variante como se fosse a
 * query digitada, cobrando TYPO_FACTOR só no fim. Cobre inserção, troca e,
 * por tabela, transposição de um caractere: "fpx" vira "fx" e acha Firefox,
 * "gmip" vira "gip" e acha o GIMP. O que aparece aqui é sempre um chute — mas
 * é um chute exibido apenas quando a alternativa é a grade vazia.
 */
export function scoreFieldsWithTypo(needle, needleMask, fields) {
    const n = needle.length;
    if (n < SEARCH.TYPO_MIN_QUERY || n > SEARCH.TYPO_MAX_QUERY)
        return NO_MATCH;
    // Uma letra pode ser descartada, então até uma classe de caractere pode
    // faltar no nome — mais do que isso não é erro de digitação, é outra
    // palavra.
    if (_missingBits(needleMask, fields.mask) > 1)
        return NO_MATCH;

    let best = NEG;
    for (let skip = 0; skip < n; skip++) {
        // Descartar um caractere repetido gera a mesma variante duas vezes.
        if (skip > 0 && needle.charCodeAt(skip) === needle.charCodeAt(skip - 1))
            continue;
        const variant = needle.slice(0, skip) + needle.slice(skip + 1);
        const raw = _rawScore(variant, fields.name, fields.starts);
        if (raw > best)
            best = raw;
    }
    if (best <= NEG)
        return NO_MATCH;

    // Normaliza pelo comprimento da VARIANTE (n - 1), que é o que de fato foi
    // casado: normalizar pelo original faria toda variante nascer com uma
    // penalidade de comprimento embutida e o limiar deixaria de significar a
    // mesma coisa nas duas passadas.
    const score = _finalScore(best, n - 1, fields.name.length);
    if (score < SEARCH.MIN_NAME_SCORE)
        return NO_MATCH;
    return Math.round(score * SEARCH.TYPO_FACTOR);
}
