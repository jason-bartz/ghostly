//! Generate `src/bindings.ts` from the tauri-specta command catalog defined
//! in the library crate, without launching the Tauri runtime.
//!
//! This binary is invoked from the `bindings:generate` npm script and from
//! the `bindings:check` CI guard. Running it is the only supported way to
//! refresh the bindings; hand-editing `src/bindings.ts` will be overwritten
//! the next time this command runs.
//!
//! Usage:
//!   cargo run -p ghostly --bin export_bindings
//!   bun run bindings:generate

use specta_typescript::{BigIntExportBehavior, Typescript};

fn main() {
    let output_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../src/bindings.ts".to_string());

    let builder = ghostly_app_lib::build_specta_builder();
    builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            &output_path,
        )
        .expect("Failed to export typescript bindings");

    println!("Wrote TypeScript bindings to {}", output_path);
}
