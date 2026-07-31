# Codex native roles

Codex custom roles are configured through `[agents.<name>].config_file`.
The plugin manifest does not register roles, so use `config.example.toml` as
an explicit opt-in configuration snippet. Relative role paths resolve from the
config file that declares the role; the example therefore uses a plugin-root
placeholder instead of guessing an install location.
