"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import styles from "./page.module.scss"; // Import SCSS module


export default function Home() {
  const [products, setProducts] = useState({});
  const [returnables, setReturnables] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadingReturnables, setLoadingReturnables] = useState(true);

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

    async function fetchReturnables() {
      try {
        const response = await fetch("/api/getReturnables");
        const data = await response.json();
        setReturnables(data);
      } catch (error) {
        console.error("Error fetching returnables:", error);
      } finally {
        setLoadingReturnables(false);
      }
    }

    fetchProducts();
    fetchReturnables();
  }, []);

  if (loading || loadingReturnables) {
    return <p className={styles.loadingText}>Loading data...</p>;
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
          priority
        />
        <h1 className={styles.title}>Product Price List</h1>
        <p>
          (REG. No 2023 / 779316 / 07)
          <br />
          6 Christelle Str, Denneburg, Paarl, Western Cape, South Africa, 7646
          <br />
          Tel / Whatsapp: <a href="tel:+27716191616">+27 (0)71 619 1616</a> | 
          Email: <a href="mailto:info@bevgo.co.za">info@bevgo.co.za</a> | 
          Website: <a href="https://bevgo.co.za" target="_blank">bevgo.co.za</a>
          <br />
          This price list can be viewed anytime at <a href="https://pricing.bevgo.co.za" target="_blank">pricing.bevgo.co.za</a>.
          <br />
        </p>
      </div>

      {/* Returnables Section */}
      <div className={styles.returnablesSection}>
        <h2 className={styles.brandTitle}>Returnables</h2>
        <p><strong>Credit Policy</strong> - 
Only crates returned with a full load of empty bottles are eligible for full credit.
For partial returns (e.g., half crates or missing bottles), only the crate itself will be credited. No credit will be issued for missing or unreturned bottles.</p><br/>
        <p><strong>Return Process</strong> - Upon receiving your order, a returnable deposit will be applied to your invoice based on the total number of returnable items. When you place your next order or request a collection, all returned items will be inspected. If they are returned in good condition and in full, the corresponding deposit will be credited back to your account. Partial or damaged returns may result in only a partial credit being issued.</p><br/>
        {Object.entries(returnables).map(([returnType, items]) => (
          <div key={returnType} className={styles.returnTypeSection}>
            <div className={styles.tableContainer}>
              <table className={styles.table}>
                <colgroup>
                  <col style={{ width: "10%" }} /> {/* Product Size */}
                  <col style={{ width: "10%" }} /> {/* Product Type */}
                  <col style={{ width: "30%" }} /> {/* Return Type */}
                  <col style={{ width: "20%" }} /> {/* Price */}
                  <col style={{ width: "10%" }} /> {/* Code */}
                </colgroup>

                <thead>
                  <tr>
                    <th className={styles.tableHeader}>Product Size</th>
                    <th className={styles.tableHeader}>Product Type</th>
                    <th className={styles.tableHeader}>Return Type</th>
                    <th className={styles.tableHeader}>Unit Price (Excl. VAT)</th>
                    <th className={styles.tableHeader}>Code</th>
                  </tr>
                </thead>

                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className={styles.tableRow}>
                      <td className={styles.tableData}>{item.product_size}</td>
                      <td className={styles.tableData}>{item.product_type}</td>
                      <td className={styles.tableData}>{item.return_type}</td>
                      <td className={styles.tableData}>R{item.price.toFixed(2)}</td>
                      <td className={styles.tableData}>{item.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* Products Section */}
      {Object.entries(products).map(([brand, items]) => (
        <div key={brand} className={styles.brandSection}>
          <h2 className={styles.brandTitle}>{brand}</h2>
          <div className={styles.tableContainer}>
            <table className={styles.table}>
              <colgroup>
                <col style={{ width: "10%" }} /> {/* Image */}
                <col style={{ width: "30%" }} /> {/* Product Name */}
                <col style={{ width: "10%" }} /> {/* Pack Size */}
                <col style={{ width: "15%" }} /> {/* Price (Excl. VAT) */}
                <col style={{ width: "15%", backgroundColor: "#fff3f1" }} /> {/* Price (Incl. VAT) */}
                <col style={{ width: "10%" }} /> {/* In Stock */}
                <col style={{ width: "10%" }} /> {/* Unique Product Code */}
              </colgroup>

              <thead>
                <tr>
                  <th className={styles.tableHeader}>Image</th>
                  <th className={styles.tableHeader}>Product</th>
                  <th className={styles.tableHeader}>Pack Size</th>
                  <th className={styles.tableHeader}>Price (Excl. VAT)</th>
                  <th className={styles.tableHeader}>Price (Incl. VAT)</th>
                  <th className={styles.tableHeader}>Unit Price (Incl. VAT)</th>
                  <th className={styles.tableHeader}>Order Code</th>
                </tr>
              </thead>

              <tbody>
                {items.map((product) => (
                  <tr key={product.id} className={styles.tableRow}>
                    <td className={styles.tableData}>
                      <Image
                        src={product.product_image}
                        alt={product.product_title}
                        width={50}
                        height={50}
                        className={styles.productImage}
                      />
                    </td>
                    <td className={styles.tableData}>{product.product_title}</td>
                    <td className={styles.tableData}>{product.pack_size}</td>
                    <td className={styles.tableData}>R{product.price_excl.toFixed(2)}</td>
                    <td className={styles.tableData}>R{product.price_incl.toFixed(2)}</td>
                    <td className={styles.tableData}>R{(product.price_incl / product.pack_size).toFixed(2)}</td>
                    <td className={styles.tableData}>{product.unique_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}


    </div>
  );
}
