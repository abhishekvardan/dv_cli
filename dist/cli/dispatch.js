/**
 * Noun-verb command routing.
 *
 * Every command group reads `<noun> <verb>` — `dv gh repo list`, `dv vercel deploy
 * list` — so the surface stays guessable as it grows. Having seen one group, you can
 * predict the next, which was not true of the older mix of `repos`, `branches` and
 * `create`.
 *
 * Shared rather than written per group: the fiddly parts (aliases, a bare noun
 * meaning "list", a name where a verb was expected) are easy to get subtly different
 * in each copy.
 */
/**
 * Work out which command was meant.
 *
 * `args.positional` holds words that appeared after a flag, which the parser keeps
 * separate from the command path — they are appended so `dv gh file read --ref main
 * src/x.ts` still finds its path.
 */
export function resolveCommand(args, shape) {
    const words = args.command.slice(1);
    const first = words[0];
    if (!first)
        return { key: '', rest: [] };
    const tail = (from) => [...words.slice(from), ...args.positional];
    if (shape.standalone?.includes(first))
        return { key: first, rest: tail(1) };
    const alias = shape.aliases?.[first];
    if (alias)
        return { key: `${alias[0]} ${alias[1]}`, rest: tail(1) };
    const verbs = shape.verbs[first];
    if (verbs) {
        const second = words[1];
        if (second && verbs.includes(second))
            return { key: `${first} ${second}`, rest: tail(2) };
        // `dv gh repo my-project` names a repo rather than a verb.
        if (second)
            return { key: `${first} view`, rest: tail(1) };
        // A bare noun means its primary verb, which is listing.
        return { key: `${first} ${verbs[0]}`, rest: [...args.positional] };
    }
    return { key: first, rest: tail(1) };
}
/** "repo      list, view, create" lines for a usage error. */
export function describeShape(shape) {
    const nouns = Object.keys(shape.verbs);
    const width = Math.max(...nouns.map((n) => n.length));
    const lines = nouns.map((noun) => `${noun.padEnd(width)}  ${shape.verbs[noun].join(', ')}`);
    if (shape.standalone?.length)
        lines.push(shape.standalone.join(', '));
    return lines.join('\n');
}
//# sourceMappingURL=dispatch.js.map