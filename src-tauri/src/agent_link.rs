//! Agent Link v1 wire and desktop connection lifecycle.
mod client;
mod identity;
mod runtime;
mod transport;
mod tunnel;
pub(crate) mod wire;
pub(crate) use client::{connect, Connection};
pub(crate) use runtime::serve;
#[cfg(test)]
mod tests;
