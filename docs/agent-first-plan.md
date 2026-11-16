# Piano: routing agent-first e configurazione MCP semplificata

Approvato da Guido il 16 novembre 2026. Implementazione senza compatibilità retroattiva.

## Obiettivo

OpenClaw è la fonte degli agenti e dei bindings Discord. Il client sceglie prima l’agente, poi una destinazione assegnata a quell’agente. Ogni scrittura verifica nuovamente l’assegnazione; la lista dei canali non costituisce da sola un’autorizzazione.

## Configurazione

Conservare MCP_DISCORD_ENABLED e MCP_DISCORD_CHANNEL_CREATE_ENABLED. Introdurre OPENCLAW_DEFAULT_AGENT_ID e OPENCLAW_AGENT_IS_MANDATORY (default false). Se mandatory è true, richiedere agent_id nello schema e sul server per tutti i tool che prevedono questo argomento; ignorare il default. Altrimenti usare agent_id, poi il default; in assenza di entrambi restituire errore. Nessun fallback implicito al Gateway.

Eliminare OPENCLAW_AGENT_ID, OPENCLAW_MODEL, MCP_AGENT_DISCOVERY, MCP_AGENT_CATALOG, MCP_DISCORD_TARGETS, MCP_DISCORD_DISCOVERY_SCOPES, MCP_DISCORD_CREATION_POLICIES, MCP_DISCORD_CHANNEL_WHITELIST e MCP_DISCORD_CHANNEL_BLACKLIST. Eliminare i corrispondenti campi JSON, bindings duplicati, alias CLI e percorsi legacy. Nessuna migrazione automatica o modalità di compatibilità. Non rimuovere per somiglianza di nome le directory di identità necessarie all’autenticazione.

Costruire internamente il campo HTTP model richiesto dal protocollo. Conservare la selezione del modello LLM tramite i tool. Credenziali, trasporto, stato e opzioni di comportamento restano separati dalle regole di destinazione.

## Fasi

1. Verificare SDK/API del Gateway per agenti, bindings e routing aggiornati, permessi necessari e uso remoto. Preferire il risolutore nativo. Se manca un’interfaccia adeguata, fermare le modifiche dipendenti e riportare il requisito, senza inventare endpoint o introdurre copie statiche.
2. Implementare un risolutore comune dell’agente. openclaw_agents deve interrogare il Gateway a ogni chiamata; anche la validazione degli agent_id deve usare dati aggiornati.
3. Implementare discovery Discord per agente e controlli condivisi prima delle scritture: creazione canali, messaggi nei canali, creazione thread e messaggi nei thread. Adeguare schemi/tool con identificativi concreti al posto delle policy.
4. Rimuovere configurazioni e codice superati; aggiornare documentazione, esempi e skill companion in modo conciso.
5. Eseguire test comportamentali, typecheck, lint e build; revisione indipendente dei controlli di routing.
6. Preparare release incompatibile e aggiornamento locale. Prima del cambio attendere operazioni attive, preservare stato ed esiti incerti e rimuovere dal launcher le configurazioni obsolete. Nessun riavvio Gateway senza permesso esplicito. Prove Discord con scritture solo in destinazioni concordate.

## Regole Discord

- Il binding specifico del canale prevale su quello del server; rispettare precedenze, account e ereditarietà dei thread del Gateway.
- Nessun binding applicabile significa nessuna scrittura, anche se esiste un agente predefinito.
- Un binding a un singolo canale non autorizza a crearne altri nel server. Nuovi canali richiedono un binding applicabile al server e channelCreateEnabled. Nessun elenco aggiuntivo di categorie.
- Verificare destinazione, appartenenza al server e permessi Discord; se routing o autorizzazione non sono verificabili, negare l’operazione. Non cambiare trasporto per aggirare un diniego.
- Definire nella verifica tecnica i limiti di concorrenza tra lettura bindings e scrittura; non promettere atomicità che il Gateway non offre.
- Conservare idempotenza, protezioni contro duplicazioni, gestione degli esiti incerti, fork same-agent e attribuzione source.

## Verifiche di accettazione

- Mandatory/default/agente mancante o inesistente, su tutti i tool interessati e trasporti.
- Agenti e bindings modificati senza riavvio MCP.
- Server di A con canale specifico di B: solo B autorizzato sul canale; controllo anche con ID passato direttamente.
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
- Prima delle modifiche Discord serve scegliere tra un’estensione Gateway per la risoluzione nativa e un perimetro MCP esplicitamente limitato, con diniego dei casi non verificabili. Nessun resolver parziale introdotto come equivalente al routing nativo.
- Report tecnico locale: /Users/openclaw/.openclaw/workspace/out/agent-first-routing-feasibility.md. Verifica su sorgenti e schemi, senza chiamate live.
- Nessuna modifica al servizio attivo o al codice funzionale.
