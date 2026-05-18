# Ideology

Virentia is a state manager for applications with complex business logic. Its goal is not to make state writes shorter. Its goal is to preserve causality: what happened, which rules ran, which external work started, and which state came out of it.

When logic is small, almost any approach looks fine. The trouble starts later: one handler changes several fields, another starts a request, another clears an error, another keeps loading state in the UI. The behavior still works, but it no longer reads as a model. Virentia is built around the opposite idea: every state movement should have a place and a name.

## Imperative Code

Imperative code is useful. It naturally describes “do this, then that”, it fits external API calls, and it is easy to read in small scenarios. Virentia does not try to ban it: an effect handler is still a normal async function, a UI callback can call an event, a reaction can write to a store, and `scoped(scope, fn)` gives ordinary code controlled access to stores.

The problem starts when imperative code becomes the only way to describe business logic. If the UI sets loading, catches errors, clears results, and decides which request to cancel, the model spreads across call sites. That code is harder to test without the interface, harder to reuse on the server, and harder to change without accidental regressions.

Virentia takes a balanced position: imperative code stays at boundaries and inside named rules, while causality is expressed through model primitives. An event names a meaningful domain action. A reaction describes a rule. An effect exposes the lifecycle of external work. A store remembers the result. This does not make code “pure” for its own sake; it makes business logic observable and portable.

## Static Shape

A fully static model is good when all state and all rules are known ahead of time. It is easier to analyze, predictable, tool-friendly, and does not make you think about lifetime. For stable parts of an application, that is a strength: if a rule always exists, it should be described near the model and not recreated without a reason.

But modern applications rarely consist of one permanent state tree. Chats, document tabs, modal flows, previews, server requests, and background screens appear and disappear at runtime. If the whole model must be global and singular, you end up threading ids through every rule, cleaning subscriptions by hand, and constantly remembering which piece of state belongs to which instance.

Virentia keeps the useful part of static shape: stores, events, effects, and reactions remain explicit definitions. But values live in a `scope`, and temporary work can live inside an `owner`. The same model can therefore be stable in shape while having several isolated runs and a real cleanup boundary.

## Concepts

A store is for memory. It answers a simple question: what should the model remember between events? A store value is not a global variable; the concrete value lives in a scope. That lets the same model run in a test, SSR request, widget, or cached screen without sharing state.

An event names something meaningful for the model: usually a fact that happened, sometimes a public intent like `open` or `close`. It does not need to say how a field should change. Because of that, one event can start several rules, and the model does not collapse into a set of setters.

An effect is for external async work. A request, storage call, worker, timer, or analytics event usually has a lifecycle: start, success, failure, cancellation, pending state. If that lifecycle stays in the UI, it quickly spreads. An effect makes it part of the model.

A reaction is for rules. By default, Virentia recommends automatic dependency tracking: the reaction reads stores, and the system understands what it depends on. This is convenient for rules that naturally follow state. Explicit `on` remains an important alternative when the trigger itself carries meaning: a specific event, effect, or lifecycle unit.

A scope is for one concrete set of model values. The model describes rules; the scope holds state for an app instance, request, test, or temporary scenario. That split makes isolation a normal part of the system, not a special testing trick.

An owner is for lifetime. If a model exists only while a modal, chat, or document tab exists, it may create reactions, subscriptions, and cleanup callbacks. `owner` gives them one boundary: when the scenario closes, temporary work is detached with it.

## Practical Balance

Virentia does not choose an extreme. It does not say “write only declarative code”, and it does not force everything into one permanent static graph. It keeps imperative code where it is useful, keeps static definitions where they give predictability, and adds scopes and owners where the application is dynamic.

The main goal is for complex business logic to remain a model, not a pile of accidental actions in UI code, router handlers, and callbacks from external libraries.
