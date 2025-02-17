"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import styles from "./page.module.scss"; // Import the updated CSS module

export default function Home() {
  const [products, setProducts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProducts() {
      try {
        const response = await fetch("/api/getProducts");
        const data = await response.json();
        setProducts(data);
      } catch (error) {
        console.error("Error fetching products:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchProducts();
  }, []);

  if (loading) {
    return <p className={styles.loadingText}>Loading products...</p>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.titleSection}>
        <Image
          src="/Bevgo Header Banner.png"
          alt="Bevgo price list header banner"
          width={1000}
          height={300}
          className={styles.titleBanner}
        />
        <h1 className={styles.title}>Product Price List</h1>

      </div>

      {Object.entries(products).map(([brand, items]) => (
        <div key={brand} className={styles.brandSection}>
          <h2 className={styles.brandTitle}>{brand}</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableHeader}>Image</th>
                <th className={styles.tableHeader}>Product</th>
                <th className={styles.tableHeader}>Pack Size</th>
                <th className={styles.tableHeader}>Price (Excl. VAT)</th>
                <th className={styles.tableHeader}>Price (Incl. VAT)</th>
                <th className={styles.tableHeader}>In Stock</th>
                <th className={styles.tableHeader}>Order on Demand</th>
              </tr>
            </thead>
            <tbody>
              {items.map((product) => (
                <tr key={product.id} className={styles.tableRow}>
                  <td className={styles.tableData} data-label="Image">
                    <div className={styles.imageContainer}>
                      <Image
                        src={product.product_image}
                        alt={product.product_title}
                        layout="fill"
                        className={styles.productImage}
                      />
                    </div>
                  </td>
                  <td className={styles.tableData} data-label="Product">
                    {product.product_title}
                  </td>
                  <td className={styles.tableData} data-label="Pack Size">
                    {product.pack_size}
                  </td>
                  <td className={styles.tableData} data-label="Price (Excl. VAT)">
                    R{product.price_excl.toFixed(2)}
                  </td>
                  <td className={styles.tableData} data-label="Price (Incl. VAT)">
                    R{product.price_incl.toFixed(2)}
                  </td>
                  <td className={styles.tableData} data-label="In Stock">
                    {product.in_stock === true ? (
                      <p>✅</p>  // If in_stock is true, show this
                    ) : (
                      <p>❌</p> // If in_stock is false, show this
                    )}
                  </td>
                  <td className={styles.tableData} data-label="Order On Demand">
                    {product.order_on_demand === true ? (
                      <p>✅</p>  // If in_stock is true, show this
                    ) : (
                      <p>❌</p> // If in_stock is false, show this
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
