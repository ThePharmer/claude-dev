# Interactive-bash defaults for Paseo's web terminals.
#
# WHY THIS LIVES IN THE IMAGE, NOT IN /home/paseo/.bashrc:
# /home/paseo is a named volume. A ~/.bashrc written there is invisible to a fresh
# volume, and the volume that exists today carries a 5-line PATH-only stub instead of
# Debian's stock skel .bashrc - which is why terminals had no colour, no completion and
# no history tuning even once SHELL=/bin/bash gave them a real bash. Shipping this in
# the image and sourcing it from /etc/bash.bashrc makes every terminal get it regardless
# of what the volume happens to contain.
#
# Sourced from the tail of /etc/bash.bashrc, i.e. only for interactive shells (that file
# returns early when PS1 is unset), and BEFORE ~/.bashrc - so anything a user later puts
# in their own ~/.bashrc still wins.

# --- prompt -------------------------------------------------------------------------
# Debian's stock skel prompt. Paseo's xterm.js frontend reports TERM=xterm-256color, so
# the colour branch is the one that actually runs here; the plain branch is kept for
# `docker exec` from a dumb terminal.
case "$TERM" in
    xterm-color|*-256color|screen*|tmux*) __paseo_color_prompt=yes ;;
    *)                                    __paseo_color_prompt= ;;
esac

if [ -n "$__paseo_color_prompt" ]; then
    PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
else
    PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
fi

# Also publish user@host: cwd as the terminal title. Paseo tracks OSC 0/2 title changes
# per session, so this puts the working directory on the terminal's tab in the web UI as
# well as in the prompt. Emitted from PS1 rather than PROMPT_COMMAND so it only repaints
# when a prompt is drawn, leaving Paseo's own during-command titles alone.
case "$TERM" in
    xterm*|rxvt*|screen*|tmux*)
        PS1="\[\e]0;${debian_chroot:+($debian_chroot)}\u@\h: \w\a\]$PS1"
        ;;
esac
unset __paseo_color_prompt

# --- history ------------------------------------------------------------------------
# Paseo runs many terminals against one $HOME, and bash only writes its history at exit -
# so without `histappend` + a per-prompt `history -a` the last terminal to close silently
# overwrites every other session's history. That combination is the actual fix; the sizes
# just stop a long-lived agent container from truncating away useful scrollback.
HISTCONTROL=ignoreboth:erasedups
HISTSIZE=100000
HISTFILESIZE=200000
HISTTIMEFORMAT='%F %T '
shopt -s histappend   # append to ~/.bash_history instead of clobbering it
shopt -s cmdhist      # keep a multi-line command as one history entry
shopt -s checkwinsize # already set by /etc/bash.bashrc; harmless and keeps this standalone

# Flush this shell's new history after every command so concurrent terminals interleave
# rather than race. Preserve any PROMPT_COMMAND already set (bash 5.1+ also allows an
# array here, but /etc/bash.bashrc leaves it unset and a string stays compatible).
PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}"

# --- aliases ------------------------------------------------------------------------
if [ -x /usr/bin/dircolors ]; then
    if [ -r ~/.dircolors ]; then
        eval "$(dircolors -b ~/.dircolors)"
    else
        eval "$(dircolors -b)"
    fi
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
fi

alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias ..='cd ..'
alias ...='cd ../..'

# Deliberately NOT aliasing rm/cp/mv to their -i forms, unlike many stock bashrc files:
# this is an agent container, and an interactive confirmation prompt is something an
# agent driving a pty can hang on indefinitely rather than answer.

# --- completion ---------------------------------------------------------------------
# Debian ships this block commented out in /etc/bash.bashrc; the bash-completion package
# is installed by the Dockerfile alongside gh, so enable it here.
if ! shopt -oq posix; then
    if [ -r /usr/share/bash-completion/bash_completion ]; then
        . /usr/share/bash-completion/bash_completion
    fi
fi
