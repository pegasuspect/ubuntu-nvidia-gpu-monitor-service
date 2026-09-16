# NVIDIA GPU Monitor Service
I created this project to monitor a freezing, 5 year old GPU to see if there 
were any peaks on GPU parameters after having to hold down power button to force
shutdown after a few complete system lock-ups.

The service records one sample per second and automatically starts to write to a
new CSV file at midnight in GPU time. Each file should be capped at 86,400  
(number of seconds in 24 hours) total lines, including its header because having
multiple smaller files are more manageable than having one giant master file. It
is also easier to just look at current day's log file to inspect GPU levels if 
your system was frozen after a reboot.

### Analysis

If you don't know how to use excel or a similar tool to draw graphs, or inspect 
the peaks, averages, or lows, just copy the log file created by this service to 
an LLM and it should tell you or give you the analysis you need.

There is also a local graph viewer under `docs/` that plots the CSV logs on an
interactive chart. See [docs/README.md](docs/README.md) for install and usage.

### Install
If you run `./install.sh` after downloading this repo, the script will install a 
linux service on your linux OS. Assuming you have an NVIDIA GPU and its drivers 
installed, it should work without issues and write to a log file in your system.
Details below.

```bash
sudo ./install.sh
```

### Verify

```bash
./status.sh
```

The service intentionally prints nothing to the terminal. Errors are available
with:

```bash
journalctl -u gpu-monitor.service
```

### Common operations

```bash
sudo systemctl restart gpu-monitor.service
sudo systemctl stop gpu-monitor.service
sudo systemctl start gpu-monitor.service
```

### Uninstall

This leaves existing CSV logs intact:

```bash
sudo ./uninstall.sh
```

Delete `/var/log/gpu-monitor` folder separately only if you also want to delete 
all the CSV log files created by the service.
