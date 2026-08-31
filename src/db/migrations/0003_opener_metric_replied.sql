-- The opener experiment measures the wrong thing.
--
-- `whatsapp_handoff` is the terminal conversion. Attributing it to the *style
-- of the first sentence* runs through the entire conversation that follows, so
-- the opener's own effect arrives diluted and late: at the warm-up volume the
-- experiment needed weeks to open its sample, and then only a very large effect
-- could clear the significance bar. It had 9 assignments and 0 conversions.
--
-- What an opener can actually cause is a reply. That is the outcome this scope
-- should be judged on; the later stages belong to experiments on the scopes
-- that drive them (`value_prop`, `cta`). `leadsThatReached` reads the immutable
-- event log, so a lead that replied and then progressed still counts here.
--
-- Nothing measured so far is lost: there were no conversions to reinterpret.

UPDATE experiments
SET primary_metric = 'replied',
    hypothesis = 'Uma abertura que cita algo concreto observado no perfil gera mais respostas do que uma abertura neutra.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE scope = 'opener' AND primary_metric = 'whatsapp_handoff';
