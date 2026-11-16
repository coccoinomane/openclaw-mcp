# Piano: routing agent-first e configurazione MCP semplificata

Approvato da Guido il 16 novembre 2026, aggiornato il 17 novembre con il perimetro Discord semplificato. Implementazione senza compatibilità retroattiva.

## Obiettivo

OpenClaw è la fonte degli agenti e dei bindings Discord. Il client sceglie prima l’agente, poi una destinazione compresa nei suoi binding. I binding definiscono il perimetro di accesso MCP, non il routing delle risposte di OpenClaw. Ogni scrittura verifica nuovamente il perimetro; la lista dei canali non costituisce da sola un’autorizzazione.

## Configurazione

Conservare MCP_DISCORD_ENABLED e MCP_DISCORD_CHANNEL_CREATE_ENABLED. Introdurre OPENCLAW_DEFAULT_AGENT_ID e OPENCLAW_AGENT_IS_MANDATORY (default false). Se mandatory è true, richiedere agent_id nello schema e sul server per tutti i tool che prevedono questo argomento; ignorare il default. Altrimenti usare agent_id, poi il default; in assenza di entrambi restituire errore. Nessun fallback implicito al Gateway.

Eliminare OPENCLAW_AGENT_ID, OPENCLAW_MODEL, MCP_AGENT_DISCOVERY, MCP_AGENT_CATALOG, MCP_DISCORD_TARGETS, MCP_DISCORD_DISCOVERY_SCOPES, MCP_DISCORD_CREATION_POLICIES, MCP_DISCORD_CHANNEL_WHITELIST e MCP_DISCORD_CHANNEL_BLACKLIST. Eliminare i corrispondenti campi JSON, bindings duplicati, alias CLI e percorsi legacy. Nessuna migrazione automatica o modalità di compatibilità. Non rimuovere per somiglianza di nome le directory di identità necessarie all’autenticazione.

Costruire internamente il campo HTTP model richiesto dal protocollo. Conservare la selezione del modello LLM tramite i tool. Credenziali, trasporto, stato e opzioni di comportamento restano separati dalle regole di destinazione.

## Fasi

1. Leggere agenti e configurazione aggiornata tramite agents.list e config.get del Gateway. Usare solo i binding Discord dell’agente selezionato, limitati a server e canali. Non serve un’estensione Gateway né un risolutore del routing effettivo.
2. Implementare un risolutore comune dell’agente. openclaw_agents deve interrogare il Gateway a ogni chiamata; anche la validazione degli agent_id deve usare dati aggiornati.
3. Implementare discovery Discord per agente e controlli condivisi prima delle scritture: creazione canali, messaggi nei canali, creazione thread e messaggi nei thread. Adeguare schemi/tool con identificativi concreti al posto delle policy.
4. Rimuovere configurazioni e codice superati; aggiornare documentazione, esempi e skill companion in modo conciso.
5. Eseguire test comportamentali, typecheck, lint e build; revisione indipendente dei controlli di routing.
6. Preparare release incompatibile e aggiornamento locale. Prima del cambio attendere operazioni attive, preservare stato ed esiti incerti e rimuovere dal launcher le configurazioni obsolete. Nessun riavvio Gateway senza permesso esplicito. Prove Discord con scritture solo in destinazioni concordate.

## Regole Discord

- Unire i canali autorizzati dai soli binding dell’agente selezionato: un binding al server include tutti i suoi canali; un binding a un canale include solo quel canale. Ignorare i binding degli altri agenti, senza precedenze o sottrazioni. Rispettare account Discord e vincoli del server quando presenti.
- I thread ereditano l’accesso dal canale padre; non considerare binding specifici ai thread. Binding generici senza server/canale e condizioni fuori dal perimetro supportato non concedono accesso.
- A legato al server può scrivere anche in un canale legato a B. Non replicare routing runtime, ruoli, broadcast o ACP.
- Nessun binding applicabile significa nessuna scrittura, anche se esiste un agente predefinito.
- Un binding a un singolo canale non autorizza a crearne altri nel server. Nuovi canali richiedono un binding applicabile al server e channelCreateEnabled. Nessun elenco aggiuntivo di categorie.
- Verificare destinazione, appartenenza al server e permessi Discord; se il perimetro o i permessi non sono verificabili, negare l’operazione. Non cambiare trasporto per aggirare un diniego.
- Definire nella verifica tecnica i limiti di concorrenza tra lettura bindings e scrittura; non promettere atomicità che il Gateway non offre.
- Conservare idempotenza, protezioni contro duplicazioni, gestione degli esiti incerti, fork same-agent e attribuzione source.

## Verifiche di accettazione

- Mandatory/default/agente mancante o inesistente, su tutti i tool interessati e trasporti.
- Agenti e bindings modificati senza riavvio MCP.
- Server di A con canale specifico di B: entrambi autorizzati su quel canale; B non autorizzato sugli altri. Controllo anche con ID passato direttamente e sui thread tramite il padre.
- Creazione canali consentita e negata, pubblicazione nei canali, thread, risposte e fork.
- Gateway indisponibile, bindings non supportati o ambigui, permessi insufficienti: errore prima degli effetti ove verificabile.
- Nessuna regressione di stato persistente, idempotenza e gestione delle operazioni incerte.
- Nessun test basato sulla presenza di parole o frasi nella documentazione.

## Esposizione prevista

Senza catalogo statico e filtri locali, il servizio espone tutti gli agenti restituiti dal Gateway e le destinazioni assegnate dai bindings. L’autenticazione MCP controlla l’accesso al servizio, non isola utenti o tenant.

## Stato

- Piano scritto prima delle modifiche funzionali.
- Verifica statica API completata: agents.list e config.get sono disponibili via SDK remoto; config.get richiede operator.read nella build ispezionata. Grant live non ancora verificato.
- Non trovata una RPC generale che esponga la decisione di routing effettiva e il binding vincente per canali/thread arbitrari e nuovi canali. I bindings di configurazione non includono tutte le assegnazioni runtime; roles, broadcast e ACP richiedono trattamento distinto.
- Guido ha scelto il perimetro limitato ai binding server/canale del solo agente selezionato. Il precedente blocco sul routing nativo è superato: implementare questo perimetro senza estensione Gateway.
- Report tecnico locale: /Users/openclaw/.openclaw/workspace/out/agent-first-routing-feasibility.md. Verifica su sorgenti e schemi, senza chiamate live.
- Implementazione completata; revisione indipendente e tre correzioni concluse. Passano 685 test in 31 file, typecheck, lint, format:check e build.
- Servizio attivo invariato. Prima del deploy locale occorre autorizzare un binding esplicito di main al server Discord: i suoi attuali binding generici non concedono accesso nel nuovo perimetro. Restano le verifiche live in sola lettura su grant e configurazione del Gateway.
