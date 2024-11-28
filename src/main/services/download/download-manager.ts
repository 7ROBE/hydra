import { Game } from "@main/entity";
import { Downloader } from "@shared";
import { PythonInstance } from "./python-instance";
import { WindowManager } from "../window-manager";
import { downloadQueueRepository, gameRepository } from "@main/repository";
import { publishDownloadCompleteNotification } from "../notifications";
import { RealDebridDownloader } from "./real-debrid-downloader";
import type { DownloadProgress } from "@types";
import { GofileApi, QiwiApi } from "../hosters";
import { GenericHttpDownloader } from "./generic-http-downloader";
import { In, Not } from "typeorm";
import path from "path";
import fs from "fs";

export class DownloadManager {
  private static currentDownloader: Downloader | null = null;
  private static downloadingGameId: number | null = null;

  public static async watchDownloads() {
    let status: DownloadProgress | null = null;

    if (this.currentDownloader === Downloader.Torrent) {
      status = await PythonInstance.getStatus();
    } else if (this.currentDownloader === Downloader.RealDebrid) {
      status = await RealDebridDownloader.getStatus();
    } else {
      status = await GenericHttpDownloader.getStatus();
    }

    if (status) {
      const { gameId, progress } = status;

      const game = await gameRepository.findOne({
        where: { id: gameId, isDeleted: false },
      });

      if (WindowManager.mainWindow && game) {
        WindowManager.mainWindow.setProgressBar(progress === 1 ? -1 : progress);

        WindowManager.mainWindow.webContents.send(
          "on-download-progress",
          JSON.parse(
            JSON.stringify({
              ...status,
              game,
            })
          )
        );
      }

      if (progress === 1 && game) {
        publishDownloadCompleteNotification(game);

        await downloadQueueRepository.delete({ game });

        const [nextQueueItem] = await downloadQueueRepository.find({
          order: {
            id: "DESC",
          },
          relations: {
            game: true,
          },
        });

        if (nextQueueItem) {
          this.resumeDownload(nextQueueItem.game);
        }
      }
    }
  }

  public static async getSeedStatus() {
    const gamesToSeed = await gameRepository.find({
      where: { shouldSeed: true, isDeleted: false },
    });

    if (gamesToSeed.length === 0) return;

    const seedStatus = await PythonInstance.getSeedStatus();

    if (seedStatus.length === 0) {
      for (const game of gamesToSeed) {
        if (game.uri && game.downloadPath) {
          await this.resumeSeeding(game.id, game.uri, game.downloadPath);
        }
      }
    }

    const gameIds = seedStatus.map((status) => status.gameId);

    for (const gameId of gameIds) {
      const game = await gameRepository.findOne({
        where: { id: gameId },
      });

      if (game) {
        const isNotDeleted = fs.existsSync(
          path.join(game.downloadPath!, game.folderName!)
        );

        if (!isNotDeleted) {
          await this.pauseSeeding(game.id);

          await gameRepository.update(game.id, {
            status: "complete",
            shouldSeed: false,
          });

          WindowManager.mainWindow?.webContents.send("on-hard-delete");
        }
      }
    }

    const updateList = await gameRepository.find({
      where: {
        id: In(gameIds),
        status: Not(In(["complete", "seeding"])),
        shouldSeed: true,
        isDeleted: false,
      },
    });

    if (updateList.length > 0) {
      await gameRepository.update(
        { id: In(updateList.map((game) => game.id)) },
        { status: "seeding" }
      );
    }

    WindowManager.mainWindow?.webContents.send(
      "on-seeding-status",
      JSON.parse(JSON.stringify(seedStatus))
    );
  }

  static async pauseSeeding(gameId: number) {
    await PythonInstance.pauseSeeding(gameId);
  }

  static async resumeSeeding(gameId: number, magnet: string, savePath: string) {
    await PythonInstance.resumeSeeding(gameId, magnet, savePath);
  }

  static async pauseDownload() {
    if (this.currentDownloader === Downloader.Torrent) {
      await PythonInstance.pauseDownload();
    } else if (this.currentDownloader === Downloader.RealDebrid) {
      await RealDebridDownloader.pauseDownload();
    } else {
      await GenericHttpDownloader.pauseDownload();
    }

    WindowManager.mainWindow?.setProgressBar(-1);
    this.currentDownloader = null;
    this.downloadingGameId = null;
  }

  static async resumeDownload(game: Game) {
    return this.startDownload(game);
  }

  static async cancelDownload(gameId = this.downloadingGameId!) {
    if (this.currentDownloader === Downloader.Torrent) {
      PythonInstance.cancelDownload(gameId);
    } else if (this.currentDownloader === Downloader.RealDebrid) {
      RealDebridDownloader.cancelDownload(gameId);
    } else {
      GenericHttpDownloader.cancelDownload(gameId);
    }

    WindowManager.mainWindow?.setProgressBar(-1);
    this.currentDownloader = null;
    this.downloadingGameId = null;
  }

  static async startDownload(game: Game) {
    switch (game.downloader) {
      case Downloader.Gofile: {
        const id = game!.uri!.split("/").pop();

        const token = await GofileApi.authorize();
        const downloadLink = await GofileApi.getDownloadLink(id!);

        GenericHttpDownloader.startDownload(game, downloadLink, {
          Cookie: `accountToken=${token}`,
        });
        break;
      }
      case Downloader.PixelDrain: {
        const id = game!.uri!.split("/").pop();

        await GenericHttpDownloader.startDownload(
          game,
          `https://pixeldrain.com/api/file/${id}?download`
        );
        break;
      }
      case Downloader.Qiwi: {
        const downloadUrl = await QiwiApi.getDownloadUrl(game.uri!);

        await GenericHttpDownloader.startDownload(game, downloadUrl);
        break;
      }
      case Downloader.Torrent:
        PythonInstance.startDownload(game);
        break;
      case Downloader.RealDebrid:
        RealDebridDownloader.startDownload(game);
    }

    this.currentDownloader = game.downloader;
    this.downloadingGameId = game.id;
  }
}
