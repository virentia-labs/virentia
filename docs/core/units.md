# Core Units

Core has several kinds of units. They are separated so a model does not turn into one object with methods for every possible case.

A store holds a value. An event reports that something happened. An effect starts work that will finish later. A reaction connects units into rules. A scope decides where values live. An owner decides when temporary work should be cleaned up.

Try not to mix those roles. If an event starts owning state, it becomes hard to find the source of truth. If a component owns loading state for an effect, async logic spreads through UI code. If a temporary model has no owner, its reactions and subscriptions are easy to forget.

## Main Units

- [Stores](/core/stores) explain what the model remembers and how values live in a scope.
- [Events](/core/events) explain how the model learns that something happened.
- [Effects](/core/effects) explain how async work and its lifecycle stay inside the model.
- [Reactions](/core/reactions) explain how to describe rules between stores, events, and effects.
- [Transactions](/core/transactions) explain when store writes become visible and how sync unit calls are ordered.
- [Lazy Models](/core/lazy-models) explain how to load a model module only when one of its units is launched.

After that, read [Scopes](/core/scopes), because without a scope there is no concrete store value.
