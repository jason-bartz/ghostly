# Home-manager module for Ghostly speech-to-text
#
# Provides a systemd user service for autostart.
# Usage: imports = [ ghostly.homeManagerModules.default ];
#        services.ghostly.enable = true;
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.ghostly;
in
{
  options.services.ghostly = {
    enable = lib.mkEnableOption "Ghostly speech-to-text user service";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "ghostly.packages.\${system}.ghostly";
      description = "The Ghostly package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.ghostly = {
      Unit = {
        Description = "Ghostly speech-to-text";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${cfg.package}/bin/ghostly";
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
