import { RouterProvider } from "react-router-dom"
import { router } from "./router"
import { ToastHost } from "./components/ui"

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
    </>
  )
}
