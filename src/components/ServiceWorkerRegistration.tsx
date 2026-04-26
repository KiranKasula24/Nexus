"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let hasRefreshedForUpdate = false;

    const handleControllerChange = () => {
      if (hasRefreshedForUpdate) return;
      hasRefreshedForUpdate = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        const activateWaitingWorker = () => {
          registration.waiting?.postMessage({ type: "SKIP_WAITING" });
        };

        if (registration.waiting) {
          activateWaitingWorker();
        }

        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener("statechange", () => {
            if (
              installingWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              activateWaitingWorker();
            }
          });
        });

        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            registration.update().catch(() => {});
          }
        });
      })
      .catch(() => {});

    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
    };
  }, []);

  return null;
}
