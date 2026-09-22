Should a small team building an internal CLI tool write its own plugin system, or
require every extension to be a separate executable the tool shells out to? The team
is four engineers, the tool already has about a dozen commands, and roughly half the
extensions they expect will be written by people outside the team.
