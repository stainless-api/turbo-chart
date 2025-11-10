#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { styleText } from "util";

interface SummaryFile {
  id: string;
  version: string;
  turboVersion: string;
  monorepo: boolean;
  execution: {
    command: string;
    repoPath: string;
    success: number;
    failed: number;
    cached: number;
    attempted: number;
    startTime: number;
    endTime: number;
    exitCode: number;
  };
  tasks: SummaryTask[];
}

interface SummaryTask {
  taskId: string;
  task: string;
  package: string;
  hash: string;
  cache: {
    local: boolean;
    remote: boolean;
    status: "MISS" | "HIT";
    timeSaved: number;
  };
  command: string;
  execution: {
    startTime: number;
    endTime: number;
    exitCode: number;
  };
}

// Configuration constants
const CONFIG = {
  TIMELINE_WIDTH: 100,
  MAX_LABEL_WIDTH: 45,
  MIN_BAR_WIDTH: 3,
  NUM_TIME_MARKERS: 8,
} as const;

let dim: "dim" | "gray" = "dim";
if (process.env.CI) {
  process.env.FORCE_COLOR = "true";
  // github actions doesn't support `dim`
  dim = "gray";
}

class TimelineRenderer {
  private readonly msToChars: number;
  private readonly startTime: number;
  private readonly endTime: number;
  private readonly totalDuration: number;
  private readonly labelWidth: number;
  private readonly packageColors: Map<string, string>;

  constructor(
    tasks: SummaryTask[],
    timelineWidth: number = CONFIG.TIMELINE_WIDTH
  ) {
    this.startTime = Math.min(...tasks.map((t) => t.execution.startTime));
    this.endTime = Math.max(...tasks.map((t) => t.execution.endTime));
    this.totalDuration = this.endTime - this.startTime;
    this.msToChars = timelineWidth / this.totalDuration;

    const maxLabelLength = Math.max(...tasks.map((t) => t.taskId.length));
    this.labelWidth = Math.min(maxLabelLength + 2, CONFIG.MAX_LABEL_WIDTH);

    // Assign colors to packages
    this.packageColors = this.assignPackageColors(tasks);
  }

  /**
   * Assign consistent colors to each unique package using 256-color palette
   */
  private assignPackageColors(tasks: SummaryTask[]): Map<string, string> {
    const uniquePackages = [...new Set(tasks.map((t) => t.package))];
    const colorCodes = [29, 31, 64, 97, 136, 166, 168];

    const packageColorMap = new Map<string, string>();
    uniquePackages.forEach((pkg, index) => {
      const colorCode = colorCodes[index % colorCodes.length]!;
      packageColorMap.set(pkg, `\x1b[48;5;${colorCode}m`);
    });

    return packageColorMap;
  }

  private getTaskColor(task: SummaryTask): string {
    return this.packageColors.get(task.package) || "\x1b[48;5;51m";
  }

  /**
   * Convert milliseconds to character positions
   */
  private timeToChars(ms: number): number {
    return Math.floor(ms * this.msToChars);
  }

  /**
   * Get evenly spaced marker positions along the timeline, including final grid line
   */
  private getMarkerPositions(): number[] {
    const positions: number[] = [];
    const width = this.timeToChars(this.totalDuration);

    for (let i = 0; i <= CONFIG.NUM_TIME_MARKERS; i++) {
      const pos = Math.floor((i / CONFIG.NUM_TIME_MARKERS) * width);
      positions.push(pos);
    }

    // Add final grid line at the end
    if (!positions.includes(width)) {
      positions.push(width);
    }

    return positions;
  }

  /**
   * Get timestamp labels for time axis
   */
  private getTimestamps(): Array<{ pos: number; label: string }> {
    const timestamps: Array<{ pos: number; label: string }> = [];

    for (let i = 0; i <= CONFIG.NUM_TIME_MARKERS; i++) {
      const time = Math.floor(
        (i / CONFIG.NUM_TIME_MARKERS) * this.totalDuration
      );
      const label = formatDuration(time);
      const pos =
        this.labelWidth +
        this.timeToChars((i / CONFIG.NUM_TIME_MARKERS) * this.totalDuration);
      timestamps.push({ pos, label });
    }

    return timestamps;
  }

  /**
   * Calculate task bar position and width
   */
  private getTaskBarBounds(task: SummaryTask): { start: number; end: number } {
    const taskStart = task.execution.startTime - this.startTime;
    const taskDuration = task.execution.endTime - task.execution.startTime;

    const barStart = this.timeToChars(taskStart);
    const barWidth = Math.max(
      CONFIG.MIN_BAR_WIDTH,
      this.timeToChars(taskDuration)
    );
    const barEnd = barStart + barWidth;

    return { start: barStart, end: barEnd };
  }

  /**
   * Render a single task timeline row
   */
  private renderTaskRow(task: SummaryTask, markerPositions: number[]): string {
    const color = this.getTaskColor(task);
    const label = task.taskId.padEnd(this.labelWidth);
    const duration = task.execution.endTime - task.execution.startTime;
    const durationLabel = formatDuration(duration);
    const { start: barStart, end: barEnd } = this.getTaskBarBounds(task);

    const width = this.timeToChars(this.totalDuration);
    let line = styleText("gray", label);
    let pendingLabel: string | null = null;

    for (let i = 0; i <= width; i++) {
      const isMarker = markerPositions.includes(i);
      const isInBar = i >= barStart && i < barEnd;

      // Try to place pending label if we have one and there's space
      if (pendingLabel && !isMarker) {
        // Check if label fits without hitting any markers
        const labelEnd = i + pendingLabel.length;
        const hasConflict = markerPositions.some(
          (pos) => pos > i && pos < labelEnd
        );

        if (!hasConflict) {
          line += styleText(dim, pendingLabel);
          i += pendingLabel.length - 1; // -1 because loop will increment
          pendingLabel = null;
          continue;
        }
      }

      // Render the timeline character
      if (isInBar) {
        line += isMarker ? `${color}│\x1b[0m` : `${color}\u00A0\x1b[0m`;
      } else {
        line += isMarker ? styleText(dim, "│") : "\u00A0";
      }

      // Set pending label when bar ends
      if (i === barEnd && pendingLabel === null) {
        pendingLabel = durationLabel;
      }
    }

    // Flush pending label at the end if it wasn't placed
    if (pendingLabel) {
      line += styleText(dim, pendingLabel);
    }

    return line;
  }

  /**
   * Render the time axis at the bottom
   */
  private renderTimeAxis(): string {
    const timestamps = this.getTimestamps();
    const width = this.timeToChars(this.totalDuration);

    // Build marker line
    let markerLine = " ".repeat(this.labelWidth);
    let labelLine = " ".repeat(this.labelWidth);

    let currentPos = this.labelWidth;
    let tsIndex = 0;

    while (
      currentPos <= this.labelWidth + width &&
      tsIndex < timestamps.length
    ) {
      const ts = timestamps[tsIndex]!;

      if (currentPos < ts.pos) {
        markerLine += " ";
        labelLine += " ";
        currentPos++;
      } else if (currentPos === ts.pos) {
        markerLine += "│";
        labelLine += "│";
        currentPos++;

        // Try to place timestamp
        const nextTs = timestamps[tsIndex + 1];
        const isLastTimestamp = tsIndex === timestamps.length - 1;
        const spaceAvailable = nextTs ? nextTs.pos - currentPos : Infinity;

        if (isLastTimestamp || spaceAvailable >= ts.label.length + 1) {
          labelLine += ts.label;
          markerLine += " ".repeat(ts.label.length);
          currentPos += ts.label.length;
        }

        tsIndex++;
      }
    }

    // Add final grid line if we haven't reached the end yet
    while (currentPos <= this.labelWidth + width) {
      if (currentPos === this.labelWidth + width) {
        markerLine += "│";
        labelLine += "│";
      } else {
        markerLine += " ";
        labelLine += " ";
      }
      currentPos++;
    }

    return styleText(dim, markerLine) + "\n" + styleText(dim, labelLine);
  }

  /**
   * Render the complete timeline
   */
  render(tasks: SummaryTask[]): void {
    // Group by package, then sort by start time within each group
    const groupedTasks = this.groupAndSortTasks(tasks);
    const markerPositions = this.getMarkerPositions();

    for (const task of groupedTasks) {
      console.log(this.renderTaskRow(task, markerPositions));
    }

    console.log(this.renderTimeAxis());
  }

  /**
   * Group tasks by package, then sort by start time within each group
   */
  private groupAndSortTasks(tasks: SummaryTask[]): SummaryTask[] {
    // Group tasks by package
    const packageGroups = new Map<string, SummaryTask[]>();

    for (const task of tasks) {
      if (!packageGroups.has(task.package)) {
        packageGroups.set(task.package, []);
      }
      packageGroups.get(task.package)!.push(task);
    }

    // Sort each group by start time
    for (const group of packageGroups.values()) {
      group.sort((a, b) => a.execution.startTime - b.execution.startTime);
    }

    // Flatten groups back into single array
    // Sort groups by the earliest start time in each group
    const sortedGroups = Array.from(packageGroups.entries()).sort(
      ([, tasksA], [, tasksB]) => {
        const minStartA = Math.min(...tasksA.map((t) => t.execution.startTime));
        const minStartB = Math.min(...tasksB.map((t) => t.execution.startTime));
        return minStartA - minStartB;
      }
    );

    return sortedGroups.flatMap(([, tasks]) => tasks);
  }
}

function getLatestRunFile(): string {
  const turboDir = path.join(process.cwd(), ".turbo", "runs");

  if (!fs.existsSync(turboDir)) {
    throw new Error(".turbo/runs directory not found");
  }

  const files = fs
    .readdirSync(turboDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(turboDir, f),
      mtime: fs.statSync(path.join(turboDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    throw new Error("No run files found in .turbo/runs");
  }

  return files[0]!.path;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 10) / 100;
  return `${seconds}s`;
}

function main() {
  try {
    const filePath = getLatestRunFile();
    const data: SummaryFile = JSON.parse(
      fs.readFileSync(filePath, "utf-8")
    ) as any;

    const totalDuration = data.execution.endTime - data.execution.startTime;

    // Header
    console.log();
    console.log(
      styleText(["bold", "cyan"], `> ${data.execution.command}`) +
        " " +
        styleText(dim, formatDuration(totalDuration))
    );

    // Timeline
    console.log();
    const renderer = new TimelineRenderer(data.tasks);
    renderer.render(data.tasks);
  } catch (error) {
    console.error(
      styleText(
        "red",
        `Error: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    process.exit(1);
  }
}

main();
